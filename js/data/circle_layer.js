'use strict';

var Layer = require('./layer');

module.exports = Layer.createClass({

    shader: 'circleShader',
    mode: Layer.Mode.TRIANGLES,
    disableStencilTest: true,

    getFeatureVerticies: function(feature, vertexCallback, elementCallback) {
        var extrudes = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        var geometries = feature.loadGeometry()[0];
        var vertexIndicies = [];

        for (var j = 0; j < geometries.length; j++) {
            for (var k = 0; k < extrudes.length; k++) {
                vertexIndicies.push(vertexCallback({
                    extrude: extrudes[k],
                    geometry: geometries[j],
                    properties: feature.properties
                }));
            }

            elementCallback([vertexIndicies[0], vertexIndicies[1], vertexIndicies[2]]);
            elementCallback([vertexIndicies[0], vertexIndicies[3], vertexIndicies[2]]);
        }
    },

    getAttributes: function() {
        return {

            pos: {
                value: function(vertex) {
                    return [
                        (vertex.geometry.x * 2) + ((vertex.extrude[0] + 1) / 2),
                        (vertex.geometry.y * 2) + ((vertex.extrude[1] + 1) / 2)
                    ];
                },
                type: Layer.AttributeType.SHORT,
                components: 2,
                shared: true
            },

            size: {
                value: this.createStyleAttributeValue('circle-radius', {multiplier: 10}),
                type: Layer.AttributeType.UNSIGNED_BYTE,
                components: 1,
                group: 'antialiasing'
            },

            blur: {
                value: createAntialaisedBlurAttributeValue(this),
                type: Layer.AttributeType.UNSIGNED_BYTE,
                components: 1,
                group: 'antialiasing'
            },

            color: {
                value: this.createStyleAttributeValue('circle-color', {multiplier: 255}),
                type: Layer.AttributeType.UNSIGNED_BYTE,
                components: 4
            },

            opacity: {
                value: this.createStyleAttributeValue('circle-opacity', {multiplier: 255}),
                type: Layer.AttributeType.UNSIGNED_BYTE,
                components: 1
            }

        };
    }
});

var BLUR_MULTIPLIER = 10;
function createAntialaisedBlurAttributeValue(layer) {

    var applyAntialiasing = function(vertex) {
        var blurValue = layer.getStyleValue('circle-blur', vertex);
        var radiusValue = layer.getStyleValue('circle-radius', vertex);

        // TODO restore this
        // var min = 1 / this.devicePixelRatio / innerRadiusValue;

        var min = 1 / 2 / radiusValue;
        return Math.max(min, blurValue) * BLUR_MULTIPLIER;
    };

    if (!layer.isStyleValueConstant('circle-blur') || !layer.isStyleValueConstant('circle-radius')) {
        return applyAntialiasing;
    } else {
        return applyAntialiasing({});
    }
}
