'use strict';

module.exports = drawCircles;

function drawCircles(painter, layer, posMatrix, tile) {
    painter.draw(tile.buckets && tile.buckets[layer.ref || layer.id], layer, tile);
}
