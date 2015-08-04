'use strict';

var test = require('prova');
var CircleLayer = require('../../../js/data/circle_layer');
var Style = require('../../../js/style/style');


// TODO don't use CircleLayer, create a simpler thing.

test('Layer', function(t) {

    t.test('getAttributeValue', function(t) {

        t.test('get non-style attribute value', function(t) {
            createLayer({id: 'map'}, function(err, layer) {
                t.error(err);

                t.deepEqual(layer.groups, ['pos']);
                t.notOk(layer.attributes.pos.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('pos', createVertex()), [4, 6.5]);

                t.end();
            });
        });

        t.test('get constant style attribute value', function(t) {
            createLayer({id: 'map'}, function(err, layer) {
                t.error(err);

                t.deepEqual(layer.groups, ['pos']);
                t.ok(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [255, 0, 0, 255]);

                t.end();
            });
        });

        t.test('get style attribute value', function(t) {
            createLayer({id: 'box'}, function(err, layer) {
                t.error(err);

                t.deepEqual(layer.groups, ['pos', 'color']);
                t.notOk(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [0.5 * 255, 0, 0.5 * 255, 255]);

                t.end();
            });
        });

        t.test('get constant style attribute value after adding a class', function(t) {
            createLayer({id: 'box'}, function(err, layer, style) {
                t.error(err);

                style._cascade({foo: true}, {});

                t.deepEqual(layer.groups, ['pos']);
                t.ok(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [0, 0, 255, 255]);

                t.end();
            });
        });

        t.test('get style attribute value after adding a class', function(t) {
            createLayer({id: 'map'}, function(err, layer, style) {
                t.error(err);

                style._cascade({foo: true}, {});

                t.deepEqual(layer.groups, ['pos', 'color']);
                t.notOk(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [0.5 * 255, 0.5 * 255, 0, 255]);

                t.end();
            });
        });

        t.test('get constant style attribute value after calling setPaintProperty', function(t) {
            createLayer({id: 'box'}, function(err, layer, style) {
                t.error(err);

                style.setPaintProperty('box', 'circle-color', '#00ff00', '');
                style._cascade({}, {});

                t.deepEqual(layer.groups, ['pos']);
                t.ok(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [0, 255, 0, 255]);

                t.end();
            });
        });

        t.test('get style attribute value after calling setPaintProperty', function(t) {
            createLayer({id: 'map'}, function(err, layer, style) {
                t.error(err);

                style.setPaintProperty('map', 'circle-color', {
                    property: 'boxiness',
                    domain: [0, 1],
                    range: ['#00ff00', '#0000ff']
                }, '');
                style._cascade({}, {});

                t.deepEqual(layer.groups, ['pos', 'color']);
                t.notOk(layer.attributes.color.isFeatureConstant);
                t.deepEqual(layer.getAttributeValue('color', createVertex()), [0, 0.5 * 255, 0.5 * 255, 255]);

                t.end();
            });
        });

        t.end();
    });

    t.end();
});

function createLayer(options, callback) {
    createStyle(function(err, style) {
        function getStyleLayer() {
            var styleLayer = style.getLayer(options.id);
            // styleLayer.recalculate(style.z, []);
            return styleLayer.json();
        }
        function getStyleConstants() { return style.stylesheet.constants; }
        function getStyleZoom() { return style.z; }

        var layer = new CircleLayer(getStyleZoom(), getStyleLayer(), getStyleConstants());

        function refresh() {
            layer.setStyle(getStyleZoom(), getStyleLayer(), getStyleConstants());
        }
        style.on('change', refresh);
        style.on('zoom', refresh);

        callback(err, layer, style);
    });
}

function createStyle(callback) {
    var style = new Style({
        version: 8,
        sources: {
            source: {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [-77.0323, 38.9131]
                    },
                    properties: {
                        boxiness: 0.5
                    }
                }
            }
        },
        layers: [
            {
                id: 'map',
                type: 'circle',
                source: 'source',
                paint: {
                    'circle-color': '#ff0000'
                },
                'paint.foo': {
                    'circle-color': {
                        property: 'boxiness',
                        domain: [0, 1],
                        range: ['#00ff00', '#ff0000']
                    }
                }
            }, {
                id: 'box',
                type: 'circle',
                source: 'source',
                paint: {
                    'circle-color': {
                        property: 'boxiness',
                        domain: [0, 1],
                        range: ['#ff0000', '#0000ff']
                    }
                },
                'paint.foo': {
                    'circle-color': '#0000ff'
                }
            }
        ]
    });

    style.on('load', function() {
        style._cascade({}, {});
        callback(null, style);
    });
}

// TODO replace with real geojson objects
function createVertex() {
    return {
        geometry: { x: 1, y: 2 },
        extrude: [ 3, 4 ],
        properties: { boxiness: 0.5 }
    };
}
