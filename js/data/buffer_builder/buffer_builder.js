'use strict';

var featureFilter = require('feature-filter');
var assert = require('assert');

var StyleDeclarationSet = require('../../style/style_declaration_set');
var LayoutProperties = require('../../style/layout_properties');
var ElementGroups = require('../element_groups');
var LayerType = require('../../layer_type');
var util = require('../../util/util');

module.exports = BufferBuilder;

BufferBuilder.create = function(options) {
    var Classes = {
        fill: require('./fill_buffer_builder'),
        line: require('./line_buffer_builder'),
        circle: require('./circle_buffer_builder'),
        symbol: require('./symbol_buffer_builder')
    };

    return new Classes[options.layer.type](options);
};

function BufferBuilder(options) {

    // TODO remove this
    util.extend(this, LayerType[options.layer.type]);

    this.buffers = options.buffers;
    this.layer = options.layer;
    this.layers = [this.layer];
    this.z = options.zoom;
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.collisionDebug = options.collisionDebug;
    this.id = options.layer.id;
    this['source-layer'] = options.layer['source-layer'];
    this.interactive = options.layer.interactive;
    this.minZoom = options.layer.minzoom;
    this.maxZoom = options.layer.maxzoom;
    this.filter = featureFilter(options.layer.filter);
    this.features = [];
    this.elementGroups = {};

    this.layoutProperties = createLayoutProperties(this.layer, this.zoom);
    this.elementGroups = createElementGroups(this.shaders, this.buffers);

    util.extend(this, createAddMethods(this.shaders));

}

BufferBuilder.prototype.addVertex = function(shaderName, args) {

    var shaderOptions = this.shaders[shaderName];
    var elementGroups = this.elementGroups[shaderName];
    var vertexBuffer = this.buffers[shaderOptions.vertexBuffer];

    // TODO automatically handle makeRoomFor?
    // TODO insert into element buffer directly?
    var value = {};
    for (var i = 0; i < shaderOptions.attributes.length; i++) {
        var attributeOptions = shaderOptions.attributes[i];
        var subvalue = attributeOptions.value.apply(this, args);

        assert(subvalue.length === attributeOptions.components);
        for (var j = 0; j < subvalue.length; j++) {
            assert(!isNaN(subvalue[j]), attributeOptions.name);
        }

        value[attributeOptions.name] = subvalue;
    }

    elementGroups.current.vertexLength++;

    return vertexBuffer.push(value) - elementGroups.current.vertexStartIndex;

};

BufferBuilder.prototype.addElement = function(shaderName, verticies, isSecondElementBuffer) {

    var shaderOptions = this.shaders[shaderName];
    var elementGroups = this.elementGroups[shaderName];

    var elementBuffer;
    if (isSecondElementBuffer) {
        assert(verticies.length === (shaderOptions.secondElementBufferComponents || 3));
        elementBuffer = this.buffers[shaderOptions.secondElementBuffer];
        elementGroups.current.secondElementLength++;
    } else {
        assert(verticies.length === (shaderOptions.elementBufferComponents || 3));
        elementBuffer = this.buffers[shaderOptions.elementBuffer];
        elementGroups.current.elementLength++;
    }

    for (var i = 0; i < verticies.length; i++) {
        assert(!isNaN(verticies[i]));
    }

    return elementBuffer.push({vertices: verticies});

};

BufferBuilder.prototype.addFeatures = function() {
    for (var i = 0; i < this.features.length; i++) {
        this.addFeature(this.features[i]);
    }
};


function createLayoutProperties(layer, zoom) {
    var values = new StyleDeclarationSet('layout', layer.type, layer.layout, {}).values();
    var fakeZoomHistory = { lastIntegerZoom: Infinity, lastIntegerZoomTime: 0, lastZoom: 0 };

    var layout = {};
    for (var k in values) {
        layout[k] = values[k].calculate(zoom, fakeZoomHistory);
    }

    if (layer.type === 'symbol') {
        // To reduce the number of labels that jump around when zooming we need
        // to use a text-size value that is the same for all zoom levels.
        // This calculates text-size at a high zoom level so that all tiles can
        // use the same value when calculating anchor positions.
        if (values['text-size']) {
            layout['text-max-size'] = values['text-size'].calculate(18, fakeZoomHistory);
            layout['text-size'] = values['text-size'].calculate(zoom + 1, fakeZoomHistory);
        }
        if (values['icon-size']) {
            layout['icon-max-size'] = values['icon-size'].calculate(18, fakeZoomHistory);
            layout['icon-size'] = values['icon-size'].calculate(zoom + 1, fakeZoomHistory);
        }
    }

    return new LayoutProperties[layer.type](layout);
}

function createElementGroups(shaders, buffers) {
    var elementGroups = {};
    Object.keys(shaders).forEach(function(shaderName) {
        var shader = shaders[shaderName];
        elementGroups[shaderName] = new ElementGroups(
            buffers[shader.vertexBuffer],
            buffers[shader.elementBuffer],
            buffers[shader.secondElementBuffer]
        );
    });
    return elementGroups;
}

function createAddMethods(shaders) {
    var methods = {};

    Object.keys(shaders).forEach(function(shaderName) {
        var shader = shaders[shaderName];

        var vertexBufferName = shader.vertexBuffer;
        methods['add' + capitalize(vertexBufferName)] = function() {
            return this.addVertex(shaderName, arguments);
        };

        var elementBufferName = shader.elementBuffer;
        if (elementBufferName) {
            methods['add' + capitalize(elementBufferName)] = function() {
                return this.addElement(shaderName, arguments);
            };
        }

        var secondElementBufferName = shader.secondElementBuffer;
        if (secondElementBufferName) {
            methods['add' + capitalize(secondElementBufferName)] = function() {
                return this.addElement(shaderName, arguments, true);
            };
        }
    });

    return methods;
}

function capitalize(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}
