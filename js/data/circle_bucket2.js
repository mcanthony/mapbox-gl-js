'use strict';

var Bucket = require('./bucket2');

module.exports = Bucket.createClass({

    type: 'circle',

    shader: 'circleShader',
    mode: Bucket.Mode.TRIANGLES,
    disableStencilTest: true,

    elementBuffer: 'circleElement',
    vertexBuffer: 'circleVertex',

    elementVertexGenerator: function(feature, vertexCallback, elementCallback) {
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

    vertexAttributes: {

        pos: {
            value: function() {
                return function(data) {
                    return [
                        (data.geometry.x * 2) + ((data.extrude[0] + 1) / 2),
                        (data.geometry.y * 2) + ((data.extrude[1] + 1) / 2)
                    ];
                };
            },
            type: Bucket.AttributeType.SHORT,
            components: 2
        },

        size: {
            value: Bucket.createStyleValue('circle-radius', {multiplier: 10}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1,
            isPerLayer: true
        },

        color: {
            value: Bucket.createStyleValue('circle-color', {multiplier: 255}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 4,
            isPerLayer: true
        },

        opacity: {
            value: Bucket.createStyleValue('circle-opacity', {multiplier: 255}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1,
            isPerLayer: true
        },

        blur: {
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1,
            value: function(layer) {
                var blurValue = Bucket.createStyleValue('circle-blur').call(this, layer);
                var radiusValue = Bucket.createStyleValue('circle-radius').call(this, layer);
                var devicePixelRatio = this.params.devicePixelRatio;

                return function(layer) {

                    function applyAntialiasing(data) {
                        var innerBlurValue = blurValue instanceof Function ? blurValue(data) : blurValue;
                        var innerRadiusValue = radiusValue instanceof Function ? radiusValue(data) : radiusValue;
                        return [Math.max(1 / (devicePixelRatio || 1) / innerRadiusValue[0], innerBlurValue[0]) * 10];
                    }

                    if (blurValue instanceof Function || radiusValue instanceof Function) {
                        return applyAntialiasing;
                    } else {
                        return applyAntialiasing({});
                    }
                };
            },
            isPerLayer: true
        }
    }

});
