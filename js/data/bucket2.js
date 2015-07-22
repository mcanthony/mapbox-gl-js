'use strict';

var Buffer = require('./buffer2');
var util = require('../util/util');
var StyleLayer = require('../style/style_layer');
var MapboxGLFunction = require('mapbox-gl-function');

/**
 * Buckets are responsible for managing all the style values, WebGL resources, and WebGL
 * configuration needed to render a particular layer. Ideally buckets will serve as the single
 * point of coupling between the "style" (style_*.js), tile parsing, and "gl" (painter.js) systems.
 */

// TODO rename to "TileLayer"?

var Bucket = {

    /**
     * Specifies the WebGL drawElements mode targeted by this buffer. See the "mode" section at
     * https://msdn.microsoft.com/en-us/library/dn302396.aspx
     * @private
     */
    Mode: {
        TRIANGLES: {
            name: 'TRIANGLES',
            verticiesPerElement: 3
        }
    },

    /**
     * @see Buffer.AttributeType
     * @private
     */
    AttributeType: Buffer.AttributeType,

    /**
     * WebGL verticies are addressed by an unsigned 16 bit integer, limiting us to 2^16 = 65535
     * verticies per `drawElements` call. For this reason, we divide features into groups, each
     * of which contains less than 65535 verticies and is rendered separately.
     * @constant {number}
     * @private
     */
    ELEMENT_GROUP_VERTEX_LENGTH: 65535,

    unserialize: function(serialized) {
        require('./circle_bucket2');

        util.assert(serialized.isSerializedMapboxBucket);
        util.assert(this.classes[serialized.type]);
        return new this.classes[serialized.type](serialized);
    },

    // TODO support classes
    // TODO send most of this logic upstream to style_layer or something
    createStyleValue: function(name, params) {
        params = params || {};

        return function(layer) {
            var calculateGlobal = MapboxGLFunction(this.styleLayers[layer.id].getPaintProperty(name));
            var calculate = calculateGlobal({$zoom: this.z});

            function inner(data) {
                util.assert(data.properties, 'The elementVertexGenerator must provide feature properties');
                return wrap(calculate(data.properties)).map(function(value) {
                    return value * (params.multiplier || 1);
                });
            }

            function wrap(value) {
                return Array.isArray(value) ? value : [ value ];
            }

            if (calculate.isFeatureConstant) {
                return inner({properties: {}});
            } else {
                return inner;
            }
        };
    },

    classes: {},

    /**
     * @param type
     * @param params
     * @param params.shader
     * @param params.mode
     * @param params.disableStencilTest (hopefully to be deprecated)
     * @param params.elementBuffer (to be deprecated)
     * @param params.vertexBuffer (to be deprecated)
     * @param params.vertexAttributes
     * @param params.vertexUniforms
     */
    createClass: function(classParams) {
        klass.params = classParams;
        klass.type = classParams.type;
        klass.shader = classParams.shader;
        klass.mode = classParams.mode;

        Bucket.classes[klass.type] = klass;

        /**
         * @param params
         * @param params.id
         * @param params.layer
         * @param params.stylesheet
         * @param params.buffers (to be deprecated)
         */
        function klass(params) {
            this.params = params;
            this.klass = klass;
            this.mode = klass.mode;
            this.disableStencilTest = classParams.disableStencilTest;
            this.id = params.id;
            this.type = klass.type;
            this.elementGroups = params.elementGroups || null;
            this.vertexLength = params.vertexLength || null;
            this.elementLength = params.elementLength || null;
            this.isElementBufferStale = params.isElementBufferStale || true;
            this.layers = params.layers;
            this.z = params.z; // TODO rename to zoom
            this.features = []; // TODO instead of storing features on the bucket, pass features ephemerally and directly to refreshBuffers

            // TODO not this
            this.styleLayers = {};
            for (var i = 0; i < this.layers.length; i++) {
                var layer = this.layers[i];
                var styleLayer = new StyleLayer(layer, params.constants);
                styleLayer.resolveLayout();
                styleLayer.resolvePaint();
                styleLayer.recalculate(params.z, []);
                this.styleLayers[layer.id] = styleLayer;
            }

            // Normalize vertex attributes
            this.vertexAttributes = [];
            for (var key in classParams.vertexAttributes) {
                var attribute = classParams.vertexAttributes[key];

                var attributeName = attribute.name || key;

                var attributeLayers;
                if (attribute.isPerLayer) {
                    attributeLayers = this.layers;
                } else {
                    attributeLayers = [null];
                }

                for (var j = 0; j < attributeLayers.length; j++) {
                    var layer = attributeLayers[j];

                    var attributeValue;
                    if (attribute.value instanceof Function) {
                        attributeValue = attribute.value.call(this, layer);
                    } else {
                        attributeValue = attribute.value;
                    }

                    this.vertexAttributes.push({
                        name: attributeName,
                        components: attribute.components || 1,
                        type: attribute.type || Bucket.AttributeType.UNSIGNED_BYTE,
                        isStale: true,
                        value: attributeValue,
                        isFeatureConstant: !(attributeValue instanceof Function),
                        layer: layer,
                        vertexBufferName: (layer ? layer.id + '::' : '') + attributeName // TODO something cleaner
                    });
                }
            }

            // Create vertex buffer
            this.vertexBuffer = new Buffer(params.vertexBuffer || {
                type: Buffer.BufferType.VERTEX,
                attributes: collect(this.eachVertexAttribute.bind(this), {
                    isFeatureConstant: false
                }).map(function(attribute) {
                    return {
                        name: attribute.vertexBufferName,
                        components: attribute.components,
                        type: attribute.type
                    };
                })
            });

            // Create element buffer
            this.elementBuffer = new Buffer(params.elementBuffer || {
                type: Buffer.BufferType.ELEMENT,
                attributes: {
                    verticies: {
                        components: this.mode.verticiesPerElement,
                        type: Buffer.INDEX_ATTRIBUTE_TYPE
                    }
                }
            });
        }

        klass.prototype.elementVertexGenerator = classParams.elementVertexGenerator;

        /**
         * @private
         * @returns a serialized version of this instance of `Bucket`, suitable for transfer between the
         * worker thread and the main thread.
         */
        // TODO provide getTransferrables
        klass.prototype.serialize = function() {
            this.refreshBuffers();

            return {
                isSerializedMapboxBucket: true,
                type: klass.type,
                id: this.id,
                elementGroups: this.elementGroups,
                elementLength: this.elementLength,
                vertexLength: this.vertexLength,
                isElementBufferStale: this.isElementBufferStale,
                layers: this.params.layers, // TODO remove this
                constants: this.params.constants, // TODO remove this
                elementBuffer: this.elementBuffer.serialize(),
                vertexBuffer: this.vertexBuffer.serialize()
            };
        };

        /**
         * Iterate over this bucket's vertex attributes
         *
         * @private
         * @param [options]
         * @param {boolean} [options.isStale]
         * @param {boolean} [options.isFeatureConstant]
         * @param {boolean} [options.eachLayer]
         * @param callback
         */
        klass.prototype.eachVertexAttribute = function(params, callback) {
            if (arguments.length === 1) {
                callback = params;
                params = {};
            }

            for (var i = 0; i < this.vertexAttributes.length; i++) {
                var attribute = this.vertexAttributes[i];

                if (params.isStale !== undefined && params.isStale !== attribute.isStale) continue;
                if (params.isFeatureConstant !== undefined && params.isFeatureConstant !== attribute.isFeatureConstant) continue;
                if (params.layer !== undefined && !(!attribute.layer || params.layer.id === attribute.layer.id || params.layer === attribute.layer.id)) continue;

                callback(attribute);
            }
        };

        /**
         * Refresh the elements buffer and/or vertex attribute buffers if necessary.
         *
         * @private
         */
        // TODO take features as an argument, don't store as a property
        // TODO refactor and simplify, even at the cost of perf
        klass.prototype.refreshBuffers = function() {
            var that = this;

            var staleVertexAttributes = collect(this.eachVertexAttribute.bind(this), {
                isStale: true,
                isFeatureConstant: false,
                eachLayer: true
            });

            // Avoid iterating over everything if all buffers are up to date
            if (!staleVertexAttributes.length && !this.isElementBufferStale) return;

            // Refresh element groups
            var elementGroup = { vertexIndex: 0, elementIndex: 0 };
            var elementGroups = this.elementGroups = [];
            function pushElementGroup(vertexIndexEnd, elementIndexEnd) {
                elementGroup.vertexLength = vertexIndexEnd - elementGroup.vertexIndex;
                elementGroup.elementLength = elementIndexEnd - elementGroup.elementIndex;
                elementGroups.push(elementGroup);
                elementGroup = { vertexIndex: vertexIndexEnd, elementIndex: elementIndexEnd };
            }

            // Refresh vertex attribute buffers
            var vertexIndex = 0;
            function vertexCallback(data) {
                for (var j = 0; j < staleVertexAttributes.length; j++) {
                    var attribute = staleVertexAttributes[j];
                    data = util.extend({ layer: attribute.layer, attribute: attribute }, data);
                    var value = attribute.value.call(that, data);
                    that.vertexBuffer.setAttribute(vertexIndex, attribute.vertexBufferName, value);
                }
                elementGroup.vertexLength++;
                return vertexIndex++;
            }

            // Refresh the element buffer
            var elementIndex = 0;
            function elementCallback(data) {
                if (that.isElementBufferStale) {
                    that.elementBuffer.add(data);
                }
                elementGroup.elementLength++;
                return elementIndex++;
            }

            // Iterate over all features
            for (var k = 0; k < this.features.length; k++) {
                var feature = this.features[k];
                var featureVertexIndex = vertexIndex;
                var featureElementIndex = elementIndex;
                this.elementVertexGenerator(feature, vertexCallback, elementCallback);

                if (elementGroup.vertexLength > Buffer.elementGroup) {
                    pushElementGroup(featureVertexIndex, featureElementIndex);
                }
            }
            pushElementGroup(vertexIndex, elementIndex);

            // Update object state, marking everything as "not stale" and updating lengths.
            for (var l in staleVertexAttributes) staleVertexAttributes[l].isStale = false;
            this.isElementBufferStale = false;
            this.vertexLength = vertexIndex;
            this.elementLength = elementIndex;
        };

        klass.prototype.isMapboxBucket = true;

        return klass;
    }

};

function collect(generator) {
    var output = [];
    var callback = function() { output.push(arguments[0]); };
    var args = Array.prototype.slice.call(arguments, 1).concat(callback);
    generator.apply(this, args);
    return output;
}

module.exports = Bucket;
