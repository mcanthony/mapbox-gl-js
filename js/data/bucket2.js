'use strict';

var Buffer = require('./buffer2');
var util = require('../util/util');
var StyleLayer = require('../style/style_layer');
var MapboxGLFunction = require('mapbox-gl-function');

/**
 * Buckets are responsible for managing all the style values, WebGL resources, and WebGL
 * configuration needed to render a particular layer. Ideally buckets will serve as the single
 * point of coupling between the "style" (style_*.js), tile parsing (worker_tile.js), and
 * "painter" (painter.js) systems.
 */
var BucketSingleton = {

    /**
     * Specifies the WebGL drawElements mode targeted by this buffer. See the "mode" section at
     * https://msdn.microsoft.com/en-us/library/dn302396.aspx
     * @private
     */
    Mode: {
        TRIANGLES: { name: 'TRIANGLES', verticiesPerElement: 3 }
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

    /**
     * Some bucket operations occur in the worker thread, some occur in the main thread. Buckets
     * can be serialized for transfer between threads.
     * @param serialized
     * @returns {Bucket}
     */
    unserialize: function(serialized, style) {
        require('./circle_bucket2');

        util.assert(serialized.isSerializedMapboxBucket);
        util.assert(this.classes[serialized.type]);
        return new this.classes[serialized.type](util.extend({style: style}, serialized));
    },

    // TODO support classes
    // TODO send most of this logic upstream to style_layer or something
    createStyleValue: function(name, params) {
        params = params || {};

        return function(layer) {
            // TODO cache these somewhere
            var styleLayer = new StyleLayer(layer, this.constants);
            styleLayer.resolveLayout();
            styleLayer.resolvePaint();
            styleLayer.recalculate(params.z, []);

            var calculateGlobal = MapboxGLFunction(styleLayer.getPaintProperty(name));
            var calculate = calculateGlobal({$zoom: this.zoom});

            var inner = (function(feature) {
                util.assert(feature.properties, 'The elementVertexGenerator must provide feature properties');
                return wrap(calculate(feature.properties)).map(function(value) {
                    return value * (params.multiplier || 1);
                });
            }).bind(this);

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
     * @param params.vertexAttributes
     * @param params.vertexUniforms
     */
    createClass: function(params) {
        function klass() { BucketClass.apply(this, arguments); }

        // TODO delete all klass properties?
        klass.type = params.type;
        klass.shader = params.shader;
        klass.mode = params.mode;
        klass.disableStencilTest = params.disableStencilTest;
        klass.vertexAttributeParams = params.vertexAttributes;

        klass.prototype = util.inherit(BucketClass, {
            klass: klass, // TODO delete klass reference?
            type: klass.type,
            shader: klass.shader,
            mode: klass.mode,
            disableStencilTest: params.disableStencilTest,
            elementVertexGenerator: params.elementVertexGenerator,
            vertexAttributeParams: params.vertexAttributes
        });

        BucketSingleton.classes[klass.type] = klass;

        return klass;
    }
};

/**
 * @param params
 * @param params.layers
 * @param params.zoom
 */
function BucketClass(params) {
    this.zoom = params.zoom;
    this.features = [];
    this.devicePixelRatio = params.devicePixelRatio || 1; // TODO gross

    // TODO always take layerIds and style
    if (params.layers && params.constants) {
        this.layers = params.layers;
        this.constants = params.constants;
    } else if (params.layerIds && params.style) {
        // TODO use public style API
        this.layers = params.layerIds.map(function(layerId) {
            return params.style.getLayer(layerId)._layer;
        });
        this.constants = params.style.stylesheet.constants;

    } else {
        util.assert(false);
    }

    this.id = this.layers[0].id;

    this.vertexAttributes = [];
    for (var key in this.vertexAttributeParams) {

        var attributeParams = this.vertexAttributeParams[key];
        var attributeName = attributeParams.name || key;
        var attributeLayers = attributeParams.shared ? [null] : this.layers;

        for (var j = 0; j < attributeLayers.length; j++) {
            var layer = attributeLayers[j];

            var attributeValue;
            if (attributeParams.value instanceof Function) {
                attributeValue = attributeParams.value.call(this, layer);
            } else {
                attributeValue = attributeParams.value;
            }

            this.vertexAttributes.push({
                name: attributeName,
                components: attributeParams.components || 1,
                type: attributeParams.type || BucketSingleton.AttributeType.UNSIGNED_BYTE,
                value: attributeValue,
                isFeatureConstant: !(attributeValue instanceof Function),
                layer: layer,
                vertexBufferName: (layer ? layer.id + '::' : '') + attributeName
            });
        }
    }

    if (params.isSerializedMapboxBucket) {

        this.elementGroups = params.elementGroups;
        this.vertexLength = params.vertexLength;
        this.elementLength = params.elementLength;

        this.vertexBuffer = new Buffer(params.vertexBuffer);
        this.elementBuffer = new Buffer(params.elementBuffer);

    } else {

        this.elementGroups = null;
        this.vertexLength = null;
        this.elementLength = null;

        var vertexBufferAttributes = collect(this.eachVertexAttribute.bind(this), { isFeatureConstant: false });
        this.vertexBuffer = new Buffer({
            type: Buffer.BufferType.VERTEX,
            attributes: vertexBufferAttributes.map(function(attribute) {
                return {
                    name: attribute.vertexBufferName,
                    components: attribute.components,
                    type: attribute.type
                };
            })
        });

        this.elementBuffer = new Buffer({
            type: Buffer.BufferType.ELEMENT,
            attributes: {
                verticies: {
                    components: this.mode.verticiesPerElement,
                    type: Buffer.INDEX_ATTRIBUTE_TYPE
                }
            }
        });

    }
}

BucketClass.prototype.isMapboxBucket = true;

/**
 * @private
 * @returns a serialized version of this instance of `Bucket`, suitable for transfer between the
 * worker thread and the main thread.
 */
// TODO provide getTransferrables
BucketClass.prototype.serialize = function() {
    this.refreshBuffers();

    return {
        isSerializedMapboxBucket: true,
        type: this.klass.type,
        elementGroups: this.elementGroups,
        elementLength: this.elementLength,
        vertexLength: this.vertexLength,
        elementBuffer: this.elementBuffer.serialize(),
        vertexBuffer: this.vertexBuffer.serialize(),
        layerIds: this.layers.map(function(layer) { return layer.id; })
    };
};

BucketClass.prototype.getTransferrables = function() {
    return [].concat(
        this.elementBuffer.getTransferrables(),
        this.vertexBuffer.getTransferrables()
    );
}

/**
 * Iterate over this bucket's vertex attributes
 *
 * @private
 * @param [options]
 * @param {boolean} [options.isFeatureConstant]
 * @param {boolean} [options.eachLayer]
 * @param callback
 */
BucketClass.prototype.eachVertexAttribute = function(params, callback) {
    if (arguments.length === 1) {
        callback = params;
        params = {};
    }

    for (var i = 0; i < this.vertexAttributes.length; i++) {
        var attribute = this.vertexAttributes[i];

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
// TODO create a buffer per attribute or attribute group
// TODO allow a set of attribute names to be passed
BucketClass.prototype.refreshBuffers = function() {
    var that = this;

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
    function vertexCallback(feature) {
        that.eachVertexAttribute({isFeatureConstant: false}, function(attribute) {
            var value = attribute.value.call(that, feature);
            that.vertexBuffer.setAttribute(vertexIndex, attribute.vertexBufferName, value);
        });
        elementGroup.vertexLength++;
        return vertexIndex++;
    }

    // Refresh the element buffer
    var elementIndex = 0;
    function elementCallback(feature) {
        that.elementBuffer.add(feature);
        elementGroup.elementLength++;
        return elementIndex++;
    }

    // Iterate over all features
    for (var k = 0; k < this.features.length; k++) {
        var feature = this.features[k];

        var featureVertexIndex = vertexIndex;
        var featureElementIndex = elementIndex;

        this.elementVertexGenerator(feature, vertexCallback, elementCallback);

        if (elementGroup.vertexLength > BucketSingleton.ELEMENT_GROUP_VERTEX_LENGTH) {
            pushElementGroup(featureVertexIndex, featureElementIndex);
        }
    }

    pushElementGroup(vertexIndex, elementIndex);
    this.vertexLength = vertexIndex;
    this.elementLength = elementIndex;
};

function collect(generator) {
    var output = [];
    var callback = function() { output.push(arguments[0]); };
    var args = Array.prototype.slice.call(arguments, 1).concat(callback);
    generator.apply(this, args);
    return output;
}

function wrap(value) {
    return Array.isArray(value) ? value : [ value ];
}

module.exports = BucketSingleton;
