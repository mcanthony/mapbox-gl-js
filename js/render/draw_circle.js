'use strict';

module.exports = drawCircles;

function drawCircles(painter, layer, posMatrix, tile) {
    var bucket = tile.buckets && tile.buckets[layer.ref || layer.id];
    if (bucket) {
        bucket.draw(painter, layer, tile);
    }
}
