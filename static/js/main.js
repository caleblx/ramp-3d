// RAMP-3D project page

// Simulated rollouts shown in the "Box Rearrangement from Language" grid.
// Each entry: video file (static/videos/), poster, task-variant tag, goal text.
const DEMOS = [{"video": "demo_1.mp4", "poster": "demo_1.jpg", "tag": "Box-type segregation", "boxes": 14, "goal": "Create stacks of boxes on pallets up to height 2, segregating by color on each pallet", "total": 14, "steps": [[0.0, 1], [1.433, 2], [2.267, 3], [3.1, 4], [3.933, 5], [4.767, 6], [5.6, 7], [6.433, 8], [7.267, 9], [8.1, 10], [8.933, 11], [9.767, 12], [10.6, 13], [11.433, 14], [12.267, 15]]}, {"video": "demo_2.mp4", "poster": "demo_2.jpg", "tag": "Box type prioritization", "boxes": 13, "goal": "Arrange the boxes in a single layer, giving preference to red boxes", "total": 13, "steps": [[0.0, 1], [1.433, 2], [2.267, 3], [3.1, 4], [3.933, 5], [4.767, 6], [5.6, 7], [6.433, 8], [7.267, 9], [8.1, 10], [8.933, 11], [9.767, 12], [10.6, 13], [11.433, 14]]}, {"video": "demo_3.mp4", "poster": "demo_3.jpg", "tag": "Box accessibility", "boxes": 15, "goal": "Create stacks of boxes up to height 3, with yellow boxes easily reachable", "total": 15, "steps": [[0.0, 1], [1.433, 2], [2.267, 3], [3.1, 4], [3.933, 5], [4.767, 6], [5.6, 7], [6.433, 8], [7.267, 9], [8.1, 10], [8.933, 11], [9.767, 12], [10.6, 13], [11.433, 14], [12.267, 15], [13.1, 16]]}];

const ROLLOUTS = [
  {
    "video": "basic_placement_01.mp4",
    "poster": "basic_placement_01.jpg",
    "tag": "Basic placement",
    "goal": "Arrange the boxes in stacks on pallets and shelves with height 3.",
    "meta": "10 boxes &middot; 10 pick-and-place steps"
  },
  {
    "video": "box_type_prioritization_02.mp4",
    "poster": "box_type_prioritization_02.jpg",
    "tag": "Box type prioritization",
    "goal": "Place all boxes on pallets and shelves without stacking, prioritizing blue boxes first.",
    "meta": "8 boxes &middot; 8 pick-and-place steps"
  },
  {
    "video": "shelf_prioritization_15.mp4",
    "poster": "shelf_prioritization_15.jpg",
    "tag": "Shelf prioritization",
    "goal": "Create stacks of boxes by filling shelves first and then pallets up to height 3.",
    "meta": "12 boxes &middot; 12 pick-and-place steps"
  },
  {
    "video": "homogeneous_stacks_06.mp4",
    "poster": "homogeneous_stacks_06.jpg",
    "tag": "Homogeneous stacks",
    "goal": "Create stacks of boxes up to height 2, with each stack containing boxes of the same color.",
    "meta": "9 boxes &middot; 9 pick-and-place steps"
  },
  {
    "video": "finish_stack_first_08.mp4",
    "poster": "finish_stack_first_08.jpg",
    "tag": "Finish stack first",
    "goal": "Arrange the boxes in stacks with height 3, ensuring one stack is completed before moving to the next.",
    "meta": "7 boxes &middot; 7 pick-and-place steps"
  },
  {
    "video": "placement_ordering_12.mp4",
    "poster": "placement_ordering_12.jpg",
    "tag": "Placement ordering",
    "goal": "Place all boxes without stacking, following a left to right approach.",
    "meta": "9 boxes &middot; 9 pick-and-place steps"
  },
  {
    "video": "avoid_stacking_27.mp4",
    "poster": "avoid_stacking_27.jpg",
    "tag": "Avoid stacking",
    "goal": "Arrange the boxes in stacks with height 3, stacking only when there are no other options.",
    "meta": "15 boxes &middot; 15 pick-and-place steps"
  },
  {
    "video": "box_type_segregation_11.mp4",
    "poster": "box_type_segregation_11.jpg",
    "tag": "Box-type segregation",
    "goal": "Create stacks of boxes on pallets up to height 3, segregating by color on each pallet.",
    "meta": "8 boxes &middot; 8 pick-and-place steps"
  },
  {
    "video": "size_based_prioritization_70.mp4",
    "poster": "size_based_prioritization_70.jpg",
    "tag": "Size-based prioritization",
    "goal": "Arrange the boxes on the large shelves first, all in a single layer.",
    "meta": "9 boxes &middot; 9 pick-and-place steps"
  }
];

(function renderRollouts() {
  const grid = document.getElementById("rollout-grid");
  if (!grid) return;
  for (const r of ROLLOUTS) {
    const fig = document.createElement("figure");
    fig.className = "video-card";
    fig.innerHTML = `
      <video muted loop playsinline preload="none" poster="static/videos/${r.poster}">
        <source src="static/videos/${r.video}" type="video/mp4">
      </video>
      <figcaption>
        <span class="tag">${r.tag}</span>
        <p class="goal">&ldquo;${r.goal}&rdquo;</p>
        <p class="meta">${r.meta}</p>
      </figcaption>`;
    grid.appendChild(fig);
  }
  if (!ROLLOUTS.length) grid.closest("section").hidden = true;

  // Only play videos while they are on screen.
  const videos = grid.querySelectorAll("video");
  if (!("IntersectionObserver" in window)) {
    videos.forEach(v => { v.preload = "auto"; v.play().catch(() => {}); });
    return;
  }
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting) { v.preload = "auto"; v.play().catch(() => {}); }
      else v.pause();
    }
  }, { threshold: 0.25 });
  videos.forEach(v => io.observe(v));
})();

// Hero demo player: several rendered demos (DEMOS) the viewer can switch between, with
// play/pause, step back/forward, seek, speed and a step counter. The first demo autoplays;
// each loops until the viewer moves on. Goal + counter are HTML over the video.
(function demoPlayer() {
  const root = document.getElementById("teaser-player");
  const v = document.getElementById("teaser-video");
  if (!root || !v || typeof DEMOS === "undefined" || !DEMOS.length) return;
  const $ = id => document.getElementById(id);
  const frame = v.closest(".teaser-frame");
  const stepEl = $("teaser-step"), goalEl = $("teaser-goal"), seek = $("tp-seek"), fill = $("tp-fill"),
        timeEl = $("tp-time"), playBtn = $("tp-play"), speedBtn = $("tp-speed"), tabsEl = $("tp-tabs");

  let cur = 0, D = DEMOS[0], starts = [], started = false;
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const stepAt = t => { let k = 0; for (let i = 0; i < starts.length; i++) if (t >= starts[i] - 1e-3) k = i; return k; };

  // one tab per demo: task variant + goal, with a progress line that fills as it plays
  const tabs = DEMOS.map((d, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "teaser-video");
    b.innerHTML = `<span class="dt-thumb"><img src="static/videos/${d.video.replace(".mp4", "_thumb.jpg")}" alt="" loading="lazy"></span>` +
      `<span class="dt-progress"><i></i></span>` +
      `<span class="dt-kicker"><span class="dt-num">${String(i + 1).padStart(2, "0")}</span>${d.tag}</span>` +
      `<span class="dt-goal">${d.goal}</span>`;
    b.addEventListener("click", () => { if (i !== cur) show(i); else { v.currentTime = 0; v.play().catch(() => {}); } });
    tabsEl.appendChild(b);
    return b;
  });
  const bars = tabs.map(b => b.querySelector(".dt-progress i"));

  let scrubbing = false, lastLabel = "";
  function render() {
    const d = v.duration || 1, t = v.currentTime;
    fill.style.width = `${(100 * t / d).toFixed(3)}%`;
    bars[cur].style.transform = `scaleX(${(t / d).toFixed(4)})`;
    if (!scrubbing) seek.value = Math.round(1000 * t / d);
    timeEl.textContent = `${fmt(t)} / ${fmt(v.duration || 0)}`;
    if (D.steps.length) {
      const k = D.steps[stepAt(t)][1];
      const label = k > D.total ? "Done" : `Step ${k} / ${D.total}`;
      if (label !== lastLabel) { stepEl.textContent = label; lastLabel = label; }
    }
  }
  function loop() { render(); if (!v.paused) requestAnimationFrame(loop); }

  function show(i, autoplay = true) {
    i = (i + DEMOS.length) % DEMOS.length;
    const first = !started; started = true;
    cur = i; D = DEMOS[i]; starts = D.steps.map(([t]) => t); lastLabel = "";
    goalEl.textContent = D.goal;
    tabs.forEach((b, k) => {
      b.setAttribute("aria-selected", String(k === i));
      b.classList.toggle("seen", k < i);
      if (k !== i) bars[k].style.transform = "";
    });
    const swap = () => {
      const rate = v.playbackRate;
      v.poster = `static/videos/${D.poster}`;
      v.src = `static/videos/${D.video}`;
      v.playbackRate = rate;
      v.addEventListener("loadeddata", () => frame.classList.remove("switching"), { once: true });
      if (autoplay) v.play().catch(() => {});
      render();
    };
    if (first) {                         // initial load: the <video> already points at demo 1
      if (!v.getAttribute("src") || !v.getAttribute("src").endsWith(D.video)) swap();
      else render();
      return;
    }
    frame.classList.add("switching");
    setTimeout(swap, 220);
  }

  function setPaused(p) {
    root.classList.toggle("paused", p);
    playBtn.setAttribute("aria-label", p ? "Play" : "Pause");
  }
  function toggle() { v.paused ? v.play().catch(() => {}) : v.pause(); }
  function jump(dir) {
    if (!starts.length) return;
    const k = stepAt(v.currentTime);
    let target = dir < 0 ? (v.currentTime - starts[k] > 0.4 ? k : k - 1) : k + 1;
    target = Math.max(0, Math.min(starts.length - 1, target));
    v.currentTime = starts[target] + 0.001;
    render();
  }

  // controls auto-hide while playing
  let idleTimer = 0;
  function wake() {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    if (!v.paused) idleTimer = setTimeout(() => root.classList.add("idle"), 2200);
  }
  root.addEventListener("pointermove", wake);
  root.addEventListener("focusin", wake);
  root.addEventListener("pointerleave", () => {
    clearTimeout(idleTimer);
    if (!v.paused) idleTimer = setTimeout(() => root.classList.add("idle"), 600);
  });

  const speeds = [1, 1.5, 2, 0.5];
  let si = 0;
  speedBtn.addEventListener("click", () => {
    si = (si + 1) % speeds.length;
    v.playbackRate = speeds[si];
    speedBtn.textContent = `${speeds[si]}×`;
  });
  playBtn.addEventListener("click", toggle);
  $("tp-prev").addEventListener("click", () => jump(-1));
  $("tp-next").addEventListener("click", () => jump(1));
  v.addEventListener("ended", () => show(cur + 1));     // play through the demos in order, then wrap
  v.addEventListener("pointerup", e => {
    if (e.pointerType !== "mouse" && root.classList.contains("idle")) { wake(); return; }
    toggle(); wake();
  });
  seek.addEventListener("input", () => {
    scrubbing = true;
    if (v.duration) v.currentTime = (seek.value / 1000) * v.duration;
    render();
  });
  seek.addEventListener("change", () => { scrubbing = false; });
  root.addEventListener("keydown", e => {
    if (e.target === seek && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); jump(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); jump(1); }
    else if (e.key === "[" || e.key === "PageUp") { e.preventDefault(); show(cur - 1); }
    else if (e.key === "]" || e.key === "PageDown") { e.preventDefault(); show(cur + 1); }
  });
  v.addEventListener("play", () => { setPaused(false); wake(); requestAnimationFrame(loop); });
  v.addEventListener("pause", () => { setPaused(true); wake(); render(); });
  v.addEventListener("seeked", render);
  v.addEventListener("loadedmetadata", render);

  show(0);
  setPaused(v.paused);
  wake();
})();

// Copy-to-clipboard for the BibTeX block.
document.querySelectorAll("button.copy").forEach(btn => {
  btn.addEventListener("click", async () => {
    const el = document.getElementById(btn.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      btn.textContent = "Copied";
    } catch {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      btn.textContent = "Selected";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1600);
  });
});
