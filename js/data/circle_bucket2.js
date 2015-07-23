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
                return function(feature) {
                    return [
                        (feature.geometry.x * 2) + ((feature.extrude[0] + 1) / 2),
                        (feature.geometry.y * 2) + ((feature.extrude[1] + 1) / 2)
                    ];
                };
            },
            type: Bucket.AttributeType.SHORT,
            components: 2,
            shared: true
        },

        size: {
            value: Bucket.createStyleValue('circle-radius', {multiplier: 10}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1
        },

        color: {
            value: Bucket.createStyleValue('circle-color', {multiplier: 255}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 4
        },

        opacity: {
            value: Bucket.createStyleValue('circle-opacity', {multiplier: 255}),
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1
        },

        blur: {
            type: Bucket.AttributeType.UNSIGNED_BYTE,
            components: 1,
            value: function(layer) {
                var blurValue = Bucket.createStyleValue('circle-blur').call(this, layer);
                var radiusValue = Bucket.createStyleValue('circle-radius').call(this, layer);

                return function(layer) {

                    var applyAntialiasing = (function(feature) {
                        var innerBlurValue = blurValue instanceof Function ? blurValue(feature) : blurValue;
                        var innerRadiusValue = radiusValue instanceof Function ? radiusValue(feature) : radiusValue;
                        return [Math.max(1 / this.devicePixelRatio / innerRadiusValue[0], innerBlurValue[0]) * 10];
                    }).bind(this);

                    if (blurValue instanceof Function || radiusValue instanceof Function) {
                        return applyAntialiasing;
                    } else {
                        return applyAntialiasing({});
                    }
                };
            }
        }
    }

});
