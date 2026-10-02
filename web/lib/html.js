// htm bound to Preact's h: html`<div class="x">${value}</div>`. Both come from node_modules through the import map.
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
