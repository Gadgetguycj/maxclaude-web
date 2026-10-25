// One shared timeline for every status light. A CSS animation starts its own clock when its element
// gets the class, so two lights that turned green at different times would blink out of step. Each
// light animation is pinned to the document timeline's origin when it starts, so every light of a
// kind shows the same phase, in the tree and in the legend alike. A light keeps its animation until
// its color changes, because the views never replace a row for a state change. Under
// prefers-reduced-motion the stylesheet removes the animations and nothing starts.

export const LIGHT_ANIMATIONS = new Set(['activity-blink', 'background-pulse']);

export function pinToTimeline(animations) {
  let pinned = 0;
  for (const animation of animations) {
    if (!LIGHT_ANIMATIONS.has(animation.animationName)) continue;
    if (animation.startTime === 0) continue;
    animation.startTime = 0;
    pinned += 1;
  }
  return pinned;
}

export function installSharedBlink(doc = document) {
  doc.addEventListener('animationstart', (ev) => {
    if (!LIGHT_ANIMATIONS.has(ev.animationName) || typeof ev.target.getAnimations !== 'function') return;
    pinToTimeline(ev.target.getAnimations());
  }, true);
}
