'use strict';

var util = require('../util/util');
var Evented = require('../util/evented');
var Buffer = require('./buffer2');
var MapboxGLFunction = require('mapbox-gl-function');
var StyleDeclarationSet = require('../style/style_declaration_set');

// TODO add eachFeature method
// TODO just use "layers" and "constants" (as are available in the worker thread) instead of `Style`
// TODO add createBuffer method

/**
 * `Layer` is a singleton object containing some constants and methods for working with layer type
 * classes.
 */
var Layer = module.exports = {

    /**
     * Create a layer class. Each layer type (circle, line, symbol, ...) should have its own layer
     * class.
     * @private
     * @param {object} options
     * @param {LayerGetAttributes} options.getAttributes
     * @param {LayerGetFeatureVerticies} options.getFeatureVerticies
     * @param {string} options.shader
     * @param {LayerMode} options.mode
     * @param {bool} options.disableStencilTest
     */
    createClass: function (options) {

        function klass() { LayerClass.apply(this, arguments); }

        klass.prototype = util.inherit(LayerClass, {
            _getAttributes: options.getAttributes,
            _getFeatureVerticies: options.getFeatureVerticies,
            shader: options.shader,
            mode: options.mode,
            disableStencilTest: options.disableStencilTest
        });

        return klass;
    },

    /**
     * Specifies what "gl.drawElements" mode will be used by this layer.
     * @private
     * @see https://msdn.microsoft.com/en-us/library/dn302396(v=vs.85).aspx
     * @enum {{name: string, verticiesPerElement: number}} LayerMode
     */
    Mode: {
        TRIANGLES: { name: 'TRIANGLES', verticiesPerElement: 3 }
    },

    /**
     * @enum LayerAttributeType
     * @private
     * @see BufferAttributeType
     */
    AttributeType: Buffer.AttributeType

};

/**
 * Layer classes encapsulate knowledge about turning `Style` objects into `Buffer` objects.
 * They are designed to be easy to spawn in the main thread and WebWorker threads.
 * `LayerClass` itself is an abstract class, extended via the `Layer.createClass` method.
 * @private
 */
function LayerClass(zoom, style, constants) {
    // TODO accept a single `Style` object in the constructor
    this.setStyle(zoom, style, constants);
}

LayerClass.prototype = util.inherit(Evented, {});

/**
 * Get the value of an attribute for a vertex in this layer's buffer.
 * @private
 * @param {(string|LayerAttribute)} attribute
 * @param {object} vertex
 */
LayerClass.prototype.getAttributeValue = function(attribute, vertex) {
    attribute = this._resolveAttributeReference(attribute);
    return attribute.value instanceof Function ? attribute.value(vertex) : attribute.value;
};

/**
 * Create an attribute value function for a style property.
 * @private
 * @param {string} property The name of the style property (i.e. circle-color)
 * @param {object} options
 * @param {number} options.multiplier is multiplied by the output of the attribute value function.
 *     It is useful for packing non-integer values (i.e. circle-blur) into integer attribute types.
 *     (i.e. UNSIGNED_BYTE)
 */
LayerClass.prototype.createStyleAttributeValue = function(property, options) {
    var that = this;
    options = options || {};

    function inner(vertex) {
        var multiplier = options.multiplier || 1;
        var values = wrap(that.getStyleValue(property, vertex));
        return values.map(function(value) { return value * multiplier; });
    }

    if (this.isStyleValueConstant(property)) {
        return inner({});
    } else {
        return inner;
    }

};

/**
 * `refreshAttributes` should be called whenever the structure of the layer changes (i.e. by adding
 * a class or by calling setPaintProperty).
 */
LayerClass.prototype.setStyle = function(zoom, style, constants) {
    this.zoom = zoom;
    this.style = style;
    this.constants = constants;

    this.paintDeclarations = new StyleDeclarationSet('paint', this.style.type, this.style.paint, this.constants).values();
    this.layoutDeclarations = new StyleDeclarationSet('layout', this.style.type, this.style.layout, this.constants).values();

    // console.log(this.paintDeclarations);

    this.groups = [];
    var inputs = this._getAttributes();
    var outputs = this.attributes = {};

    for (var key in inputs) {
        var input = inputs[key];

        var name = input.name || key;
        var group = input.group || name;

        var output = outputs[name] = {
            name: name,
            shaderName: 'a_' + name,
            components: input.components || 1,
            type: input.type || Layer.AttributeType.UNSIGNED_BYTE,
            value: input.value,
            isFeatureConstant: !(input.value instanceof Function),
            group: group
        };

        if (this.groups.indexOf(group) === -1 && !output.isFeatureConstant) {
            this.groups.push(group);
        }
    }

    this.fire('change');
};

LayerClass.prototype._getStyleFunction = function(property) {
    var declaration = this.paintDeclarations[property] || this.layoutDeclarations[property];
    return declaration.calculate || MapboxGLFunction(declaration.value); // TODO cache these
};

LayerClass.prototype.isStyleValueConstant = function(property) {
    return this._getStyleFunction(property).isFeatureConstant;
};

LayerClass.prototype.getStyleValue = function(property, vertex) {
    return this._getStyleFunction(property)({$zoom: this.zoom})(vertex.properties || {});
};

LayerClass.prototype._resolveAttributeReference = function(attribute) {
    return typeof attribute === 'string' ? this.attributes[attribute] : attribute;
};

function wrap(value) {
    if (Array.isArray(value)) {
        return value;
    } else {
        return [value];
    }
}
