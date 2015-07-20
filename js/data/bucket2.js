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

    // TODO this needs to always return a function. It doesn't yet have access to the styleLayer
    // and such. Best is probably a function -> function -> value flow, like in GLFunction.
    // TODO support classes
    // TODO send most of this logic upstream to style_layer or something
    createStyleValue: function(name, params) {
        params = params || {};
        return function() {
            var calculateGlobal = MapboxGLFunction(this.styleLayer.getPaintProperty(name));
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
        }
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
        klass.elementBuffer = classParams.elementBuffer;
        klass.vertexBuffer = classParams.vertexBuffer;
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
            this.id = params.id;
            this.type = klass.type;
            this.layer = params.layer;
            this.stylesheet = params.stylesheet;
            this.buffers = params.buffers;
            this.elementGroups = params.elementGroups || null;
            this.vertexLength = params.vertexLength || null;
            this.elementLength = params.elementLength || null;
            this.isElementBufferStale = params.isElementBufferStale || true;
            this.z = params.z;

            this.params = params;
            this.klass = klass;

            this.styleLayer = new StyleLayer(params.layer, params.constants);
            this.styleLayer.resolveLayout();
            this.styleLayer.resolvePaint();
            this.styleLayer.recalculate(params.z, []);

            // Normalize vertex attributes
            this.vertexAttributes = {};
            for (var attributeName in classParams.vertexAttributes) {
                var attribute = classParams.vertexAttributes[attributeName];

                var attributeValue
                if (attribute.value instanceof Function) {
                    attributeValue = attribute.value.call(this, classParams)
                } else {
                    attributeValue = attribute.value
                }

                this.vertexAttributes[attribute.name || attributeName] = {
                    name: attribute.name || attributeName,
                    components: attribute.components || 1,
                    type: attribute.type || Bucket.AttributeType.UNSIGNED_BYTE,
                    isStale: true,
                    buffer: classParams.vertexBuffer,
                    value: attributeValue,
                    isFeatureConstant: !(attributeValue instanceof Function),
                };
            }

            // The layer ids of secondary layers ref-ed to this bucket will be inserted into
            // this.array. Initializing this property prevents errors from being thrown but this
            // class does not fully implement ref-ed layers. Truly supporting ref-ed layers for data
            // driven styles is going to be a large lift.
            // TODO rename to "referencedLayers" and truly support this functionality
            this.layers = [];

            // TODO instead of storing features on the bucket, pass features ephemerally and
            // directly to refreshBuffers
            this.features = [];
        }

        klass.prototype.elementVertexGenerator = classParams.elementVertexGenerator;

        /**
         * @private
         * @returns a serialized version of this instance of `Bucket`, suitable for transfer between the
         * worker thread and the main thread.
         */
        klass.prototype.serialize = function() {
            this.refreshBuffers();

            return {
                type: klass.type,
                isSerializedMapboxBucket: true,
                id: this.id,
                elementGroups: this.elementGroups,
                elementLength: this.elementLength,
                vertexLength: this.vertexLength,
                isElementBufferStale: this.isElementBufferStale,
                layer: this.params.layer, // TODO remove this
                constants: this.params.constants // TODO remove this
            };
        };

        /**
         * Iterate over this bucket's vertex attributes
         *
         * @private
         * @param [filter]
         * @param {boolean} filter.isStale
         * @param {boolean} filter.isFeatureConstant
         * @param callback
         */
        klass.prototype.eachVertexAttribute = function(filters, callback) {
            if (arguments.length === 1) {
                callback = filters;
                filters = {};
            }

            for (var attributeName in this.vertexAttributes) {
                var attribute = this.vertexAttributes[attributeName];

                if (filters.isStale !== undefined && filters.isStale !== attribute.isStale) continue;
                if (filters.isFeatureConstant !== undefined && filters.isFeatureConstant !== attribute.isFeatureConstant) continue;

                callback(attribute);
            }
        };

        /**
         * Refresh the elements buffer and/or vertex attribute buffers if necessary.
         *
         * @private
         */
        // TODO take features as an argument, don't store as a property
        klass.prototype.refreshBuffers = function() {
            var that = this;

            var staleVertexAttributes = [];
            this.eachVertexAttribute({isStale: true, isFeatureConstant: false}, function(attribute) {
                staleVertexAttributes.push(attribute);
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
                    var value = attribute.value.call(that, data);
                    that.buffers[attribute.buffer].setAttribute(vertexIndex, attribute.name, value);
                }
                elementGroup.vertexLength++;
                return vertexIndex++;
            }

            // Refresh the element buffer
            var elementIndex = 0;
            function elementCallback(data) {
                if (that.isElementBufferStale) {
                    that.buffers[klass.elementBuffer].add(data);
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

module.exports = Bucket;
