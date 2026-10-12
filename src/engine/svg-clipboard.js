/* Prefer the vector payload when a design tool also supplies a PNG preview. */
(function (root) {
  'use strict';
  function extract(value) {
    var match = String(value || '').match(/<svg\b[\s\S]*<\/svg\s*>/i);
    return match ? match[0] : null;
  }
  function read(data) {
    if (!data) return null;
    var text = extract(data.getData('image/svg+xml')) || extract(data.getData('text/plain')) || extract(data.getData('text/html'));
    if (text) return Promise.resolve(text);
    var items = Array.from(data.items || []);
    var item = items.find(function (item) { return item.type === 'image/svg+xml'; });
    if (item) {
      var file = item.getAsFile();
      if (file) return file.text();
    }
    if (/data-figma|\(figma\)/i.test(data.getData('text/html'))) {
      return Promise.reject(new Error('In Figma, choose Copy/Paste as > Copy as SVG, then paste here.'));
    }
    return null;
  }
  function normalize(markup) {
    var text = extract(markup);
    if (!text) throw new Error('No SVG markup on the clipboard');
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var svg = doc.documentElement;
    if (doc.querySelector('parsererror') || svg.localName !== 'svg') throw new Error('That is not valid SVG');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    doc.querySelectorAll('script, foreignObject, iframe, object, embed, link').forEach(function (node) { node.remove(); });
    [svg].concat(Array.from(svg.querySelectorAll('*'))).forEach(function (node) {
      Array.from(node.attributes).forEach(function (attribute) {
        if (/^on/i.test(attribute.name) || (/href$/i.test(attribute.name) && !/^(#|data:image\/(png|jpeg|webp);base64,)/i.test(attribute.value))) node.removeAttribute(attribute.name);
      });
    });
    var box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
      ['width', 'height'].forEach(function (key, i) { if (!svg.hasAttribute(key) || /%/.test(svg.getAttribute(key))) svg.setAttribute(key, box[i + 2]); });
    }
    return new XMLSerializer().serializeToString(svg);
  }
  function editing(target) { return !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))); }
  root.SVGClipboard = { read: read, normalize: normalize, editing: editing };
})(typeof module !== 'undefined' ? module.exports : self);
