// Preact and htm, vendored as plain modules because the page allows only same-origin scripts and
// has no build step. Views write markup with the html tag.
import { h, render, Component, Fragment, createRef } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';

// Preact sets a prop as a DOM property when the element has one of that name. These properties
// are booleans, so "false", "off" and "no" are truthy and turned the feature on. The html tag sets
// them as attributes, as written. aria-*, data-*, readonly, inputmode and enterkeyhint already
// reach the DOM as attributes, and autocomplete and autocapitalize are string properties.
const ATTRIBUTES = new Set(['autocorrect', 'spellcheck', 'translate', 'draggable', 'writingsuggestions']);

function setAttributes(el, attrs) {
  for (const name in attrs) {
    const value = attrs[name];
    if (value === null || value === undefined) el.removeAttribute(name);
    else if (el.getAttribute(name) !== String(value)) el.setAttribute(name, String(value));
  }
}

function element(type, props, ...children) {
  if (typeof type !== 'string' || !props || !Object.keys(props).some((name) => ATTRIBUTES.has(name))) {
    return h(type, props, ...children);
  }
  const attrs = {};
  const rest = {};
  for (const name in props) (ATTRIBUTES.has(name) ? attrs : rest)[name] = props[name];
  const ref = props.ref;
  rest.ref = (el) => {
    if (el) setAttributes(el, attrs);
    if (typeof ref === 'function') return ref(el);
    if (ref) ref.current = el;
    return undefined;
  };
  return h(type, rest, ...children);
}

export const html = htm.bind(element);
export { render, Component, Fragment, createRef };
