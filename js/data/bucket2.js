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

            var inner = function(feature) {
                util.assert(feature.properties, 'The elementVertexGenerator must provide feature properties');
                return wrap(calculate(feature.properties)).map(function(value) {
                    return value * (params.multiplier || 1);
                });
            };

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

        klass.type = params.type;

        klass.prototype = util.inherit(BucketClass, {
            type: params.type,
            shader: params.shader,
            mode: params.mode,
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
    this.tileSource = params.tileSource; // TODO gross
    this.tileUID = params.tileUID; // TODO gross

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
    this.vertexAttributeGroups = [];
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

            var attributeBufferName = (layer ? layer.id + '::' : '') + attributeName;

            var attributeGroup = attributeParams.group || attributeBufferName;

            this.vertexAttributes.push({
                bufferName: attributeBufferName,
                shaderName: 'a_' + attributeName,
                components: attributeParams.components || 1,
                type: attributeParams.type || BucketSingleton.AttributeType.UNSIGNED_BYTE,
                value: attributeValue,
                isFeatureConstant: !(attributeValue instanceof Function),
                layer: layer,
                group: attributeGroup
            });

            if (this.vertexAttributeGroups.indexOf(attributeGroup) === -1) {
                this.vertexAttributeGroups.push(attributeGroup);
            }
        }
    }

    if (params.isSerializedMapboxBucket) {

        this.elementGroups = params.elementGroups;
        this.vertexLength = params.vertexLength;
        this.elementLength = params.elementLength;

        this.elementBuffer = new Buffer(params.elementBuffer);
        this.vertexBuffers = {};
        for (var group in params.vertexBuffers) {
            this.vertexBuffers[group] = new Buffer(params.vertexBuffers[group]);
        }

    } else {

        this.elementGroups = null;
        this.vertexLength = null;
        this.elementLength = null;
        this.elementBuffer = null;
        this.vertexBuffers = null;

    }
}

BucketClass.prototype.isMapboxBucket = true;

/**
 * @private
 * @returns a serialized version of this instance of `Bucket`, suitable for transfer between the
 * worker thread and the main thread.
 */
BucketClass.prototype.serialize = function() {
    this.updateBuffers();

    var serializedVertexBuffers = {};
    for (var i in this.vertexAttributeGroups) {
        var group = this.vertexAttributeGroups[i];
        serializedVertexBuffers[group] = this.vertexBuffers[group].serialize();
    }

    return {
        isSerializedMapboxBucket: true,
        type: this.type,
        elementGroups: this.elementGroups,
        elementLength: this.elementLength,
        vertexLength: this.vertexLength,
        elementBuffer: this.elementBuffer.serialize(),
        vertexBuffers: serializedVertexBuffers,
        layerIds: this.layers.map(function(layer) { return layer.id; })
    };
};

// TODO this operation has mad side effects btw
// Fix by making buffers ephemeral & cached
BucketClass.prototype.getTransferrables = function() {
    var transferrables = [];
    for (var i in this.vertexAttributeGroups) {
        var group = this.vertexAttributeGroups[i];
        transferrables = transferrables.concat(this.vertexBuffers[group].getTransferrables());
    }
    return transferrables.concat(this.elementBuffer.getTransferrables());
};

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
        if (params.group !== undefined && params.group !== attribute.group) continue;

        callback.call(this, attribute);
    }
};

BucketClass.prototype.draw = function(painter, layer, tile) {

    // Empty GeoJSON tiles have nothing to draw. They have no buckets or buffers.
    if (!tile.buckets || !tile.buffers) return;

    // short-circuit if tile is empty
    if (!this.elementLength) return;

    var gl = painter.gl;
    var shader = painter[this.shader];

    // Allow circles to be drawn across boundaries, so that
    // large circles are not clipped to tiles
    if (this.disableStencilTest) gl.disable(gl.STENCIL_TEST);

    gl.switchShader(shader, tile.posMatrix, tile.exMatrix);

    // Bind per-layer values as vertex attributes
    this.eachVertexAttribute({isFeatureConstant: true, layer: layer}, function(attribute) {
        var attributeShaderLocation = shader[attribute.shaderName];
        util.assert(attributeShaderLocation !== undefined);
        util.assert(attributeShaderLocation !== 0);
        gl.disableVertexAttribArray(attributeShaderLocation);
        gl['vertexAttrib' + attribute.components + 'fv'](attributeShaderLocation, wrap(attribute.value));
    });

    for (var i in this.elementGroups) {
        var elementGroup = this.elementGroups[i];

        this.elementBuffer.bind(gl);

        for (var j in this.vertexAttributeGroups) {
            var attributeGroup = this.vertexAttributeGroups[j];

            var vertexBuffer = this.vertexBuffers[attributeGroup];
            vertexBuffer.bind(gl);

            /* eslint no-loop-func:0 */
            this.eachVertexAttribute(
                {isFeatureConstant: false, group: attributeGroup, layer: layer},
                function(attribute) {
                    var attributeShaderLocation = shader[attribute.shaderName];
                    util.assert(attributeShaderLocation !== undefined);

                    vertexBuffer.bindVertexAttribute(
                        gl,
                        attributeShaderLocation,
                        elementGroup.vertexIndex,
                        attribute.bufferName
                    );
                }
            );
        }

        gl.drawElements(
            gl[this.mode.name],
            elementGroup.elementLength * this.mode.verticiesPerElement,
            gl[Buffer.INDEX_ATTRIBUTE_TYPE.name],
            this.elementBuffer.getIndexOffset(elementGroup.elementIndex)
        );
    }

    if (this.disableStencilTest) gl.enable(gl.STENCIL_TEST);

};

/**
 * Refresh the elements buffer and/or vertex attribute buffers if necessary.
 *
 * @private
 */
// TODO take features as an argument, don't store as a property
// TODO refactor and simplify, even at the cost of perf
// TODO create a buffer per attribute or attribute group
BucketClass.prototype.updateBuffers = function(vertexAttributeGroups) {
    vertexAttributeGroups = vertexAttributeGroups || this.vertexAttributeGroups;
    var that = this;

    this.vertexBuffers = {};
    for (var i in vertexAttributeGroups) {
        var group = vertexAttributeGroups[i];

        var attributes = collect(that.eachVertexAttribute.bind(that), {
            isFeatureConstant: false,
            group: group
        });

        this.vertexBuffers[group] = new Buffer({
            type: Buffer.BufferType.VERTEX,
            attributes: attributes.map(function(attribute) {
                return {
                    name: attribute.bufferName,
                    components: attribute.components,
                    type: attribute.type
                };
            })
        });
    }

    this.elementBuffer = new Buffer({
        type: Buffer.BufferType.ELEMENT,
        attributes: {
            verticies: {
                components: this.mode.verticiesPerElement,
                type: Buffer.INDEX_ATTRIBUTE_TYPE
            }
        }
    });

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
        for (var i in vertexAttributeGroups) {
            var group = vertexAttributeGroups[i];
            that.eachVertexAttribute({isFeatureConstant: false, group: group}, function(attribute) {
                var value = attribute.value.call(that, feature);
                that.vertexBuffers[group].setAttribute(vertexIndex, attribute.bufferName, value);
            });
        }
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

    var output = {};
    for (var k in vertexAttributeGroups) {
        var group = vertexAttributeGroups[k];
        output[group] = this.vertexBuffers[group];
    }
    return output;
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
