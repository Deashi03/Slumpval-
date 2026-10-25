/* Gesture-only 3×3 pattern entry. No network, history or stored pattern. */
"use strict";
window.SlumpvalPattern = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const coords = Array.from({ length: 9 }, (_, i) => ({ x: 50 + 100 * (i % 3), y: 50 + 100 * Math.floor(i / 3) }));
  function svgElement(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  }
  function divisor(a, b) {
    while (b) { const next = a % b; a = b; b = next; }
    return a;
  }
  function missedDots(from, to) {
    const x = Math.abs(from % 3 - to % 3);
    const y = Math.abs(Math.floor(from / 3) - Math.floor(to / 3));
    const parts = divisor(x, y);
    if (parts < 2) return [];
    const dx = ((to % 3) - (from % 3)) / parts;
    const dy = (Math.floor(to / 3) - Math.floor(from / 3)) / parts;
    const result = [];
    for (let i = 1; i < parts; i++) {
      result.push((Math.floor(from / 3) + i * dy) * 3 + from % 3 + i * dx);
    }
    return result;
  }

  function mount(element, onComplete) {
    const svg = svgElement("svg", { viewBox: "0 0 300 300", class: "pattern-svg", "aria-hidden": "true" });
    const activeLine = svgElement("polyline", { class: "pattern-line", points: "" });
    const tail = svgElement("line", { class: "pattern-tail", x1: 0, y1: 0, x2: 0, y2: 0 });
    svg.append(activeLine, tail);
    const dots = coords.map((point, i) => {
      const hit = svgElement("circle", { cx: point.x, cy: point.y, r: 34, class: "pattern-hit", "data-dot": i });
      const halo = svgElement("circle", { cx: point.x, cy: point.y, r: 22, class: "pattern-halo" });
      const core = svgElement("circle", { cx: point.x, cy: point.y, r: 7.5, class: "pattern-dot" });
      svg.append(halo, core, hit);
      return { halo, core };
    });
    element.replaceChildren(svg);
    let selected = [];
    let active = false;
    let pointer = null;
    let previous = null;
    let enabled = true;
    const coordinates = event => {
      const rect = svg.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * 300 / rect.width,
        y: (event.clientY - rect.top) * 300 / rect.height
      };
    };
    const closest = (point, threshold = 35) => {
      let result = -1;
      let best = threshold * threshold;
      coords.forEach((dot, i) => {
        const distance = (dot.x - point.x) ** 2 + (dot.y - point.y) ** 2;
        if (distance <= best) { best = distance; result = i; }
      });
      return result;
    };
    const append = index => {
      if (index < 0 || selected.includes(index)) return;
      if (selected.length) {
        for (const between of missedDots(selected[selected.length - 1], index)) {
          if (!selected.includes(between)) selected.push(between);
        }
      }
      selected.push(index);
    };
    const draw = point => {
      dots.forEach((dot, i) => {
        dot.halo.classList.toggle("selected", selected.includes(i));
        dot.core.classList.toggle("selected", selected.includes(i));
      });
      activeLine.setAttribute("points", selected.map(i => coords[i].x + "," + coords[i].y).join(" "));
      if (point && selected.length) {
        const last = coords[selected[selected.length - 1]];
        tail.setAttribute("x1", last.x);
        tail.setAttribute("y1", last.y);
        tail.setAttribute("x2", point.x);
        tail.setAttribute("y2", point.y);
        tail.style.display = "";
      } else {
        tail.style.display = "none";
      }
    };
    const track = point => {
      if (!previous) previous = point;
      // Catch dots crossed by a quick finger motion between two pointer events.
      const crossed = [];
      const start = previous;
      const vx = point.x - start.x;
      const vy = point.y - start.y;
      const lengthSq = vx * vx + vy * vy;
      coords.forEach((dot, i) => {
        if (selected.includes(i)) return;
        const t = lengthSq ? Math.max(0, Math.min(1, ((dot.x - start.x) * vx + (dot.y - start.y) * vy) / lengthSq)) : 0;
        const x = start.x + vx * t, y = start.y + vy * t;
        if (Math.hypot(dot.x - x, dot.y - y) <= 29) crossed.push({ i, t });
      });
      crossed.sort((a, b) => a.t - b.t).forEach(dot => append(dot.i));
      append(closest(point));
      previous = point;
      draw(point);
    };
    const reset = () => {
      active = false;
      pointer = null;
      previous = null;
      selected = [];
      draw(null);
    };
    const start = event => {
      if (!enabled || !event.isPrimary || active) return;
      const point = coordinates(event);
      const index = closest(point);
      if (index < 0) return;
      event.preventDefault();
      reset();
      active = true;
      pointer = event.pointerId;
      svg.setPointerCapture(event.pointerId);
      append(index);
      previous = point;
      draw(point);
    };
    const move = event => {
      if (!active || event.pointerId !== pointer) return;
      event.preventDefault();
      track(coordinates(event));
    };
    const end = event => {
      if (!active || event.pointerId !== pointer) return;
      event.preventDefault();
      track(coordinates(event));
      const result = selected.slice();
      reset();
      if (result.length) onComplete(result);
    };
    const cancel = () => reset();
    svg.addEventListener("pointerdown", start);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", cancel);
    svg.addEventListener("lostpointercapture", () => { if (active) reset(); });
    return {
      reset,
      setEnabled(value) { enabled = Boolean(value); if (!enabled) reset(); }
    };
  }
  return { mount, missedDots };
})();