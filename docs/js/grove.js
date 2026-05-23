// Grove site — shared scripts + motion system

// Light theme only — force-clear any previously persisted dark mode.
document.documentElement.removeAttribute('data-theme');
try { localStorage.removeItem('grove-theme'); } catch (_) {}

// ─────────────────────────────────────────────────────────────────
// Active nav link from current path
// ─────────────────────────────────────────────────────────────────
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    const slug = path.replace('.html', '') || 'index';
    document.querySelectorAll('.nav-links a[data-page]').forEach((a) => {
      if (a.dataset.page === slug) a.classList.add('active');
    });
  });
})();

// ─────────────────────────────────────────────────────────────────
// Motion system
//
// Strategy:
//   1. If user prefers-reduced-motion → fall back to plain CSS reveal.
//   2. If GSAP failed to load (offline / CDN block) → fall back to
//      IntersectionObserver CSS reveal (the original behavior).
//   3. Otherwise wire a full GSAP + ScrollTrigger experience.
//
// All animations only target elements that exist on the page, so the
// same script works for every page without per-page branching.
// ─────────────────────────────────────────────────────────────────

const reducedMotion =
  (window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
  /(\?|&)nomotion(=1|=true)?(&|$)/i.test(window.location.search);

// ── Fallback: original CSS scroll reveal ──
function initFallbackReveal() {
  if (!('IntersectionObserver' in window)) {
    document
      .querySelectorAll('[data-animate]')
      .forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
  );
  document.querySelectorAll('[data-animate]').forEach((el) => io.observe(el));
}

// ── Word splitter (free SplitText replacement) ──
// Wraps each word in <span class="g-word"><span class="g-word-inner">word</span></span>
// so we can clip-reveal individual words.
function splitWords(el) {
  if (!el || el.dataset.gSplit === '1') return;
  const text = el.textContent;
  // Don't split if there's nested HTML like <span class="br-moss"> — instead split each text-node child.
  if (el.children.length > 0) {
    // Walk children, splitting text nodes only, preserving any nested spans.
    const walk = (node) => {
      const out = [];
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const parts = child.textContent.split(/(\s+)/);
          parts.forEach((p) => {
            if (p.match(/^\s+$/)) {
              out.push(document.createTextNode(p));
            } else if (p.length > 0) {
              const wrap = document.createElement('span');
              wrap.className = 'g-word';
              const inner = document.createElement('span');
              inner.className = 'g-word-inner';
              inner.textContent = p;
              wrap.appendChild(inner);
              out.push(wrap);
            }
          });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // <br> must pass through — wrapping it in inline-block kills the line break.
          if (child.tagName === 'BR') {
            out.push(child.cloneNode(true));
          } else {
            // Wrap inline elements (e.g. <span class="br-moss">) as a single "word".
            const wrap = document.createElement('span');
            wrap.className = 'g-word';
            const inner = document.createElement('span');
            inner.className = 'g-word-inner';
            inner.appendChild(child.cloneNode(true));
            wrap.appendChild(inner);
            out.push(wrap);
          }
        } else if (child.nodeType === Node.COMMENT_NODE) {
          out.push(child.cloneNode(true));
        }
      });
      return out;
    };
    const newNodes = walk(el);
    el.innerHTML = '';
    newNodes.forEach((n) => el.appendChild(n));
  } else {
    const parts = text.split(/(\s+)/);
    el.innerHTML = '';
    parts.forEach((p) => {
      if (p.match(/^\s+$/)) {
        el.appendChild(document.createTextNode(p));
      } else if (p.length > 0) {
        const wrap = document.createElement('span');
        wrap.className = 'g-word';
        const inner = document.createElement('span');
        inner.className = 'g-word-inner';
        inner.textContent = p;
        wrap.appendChild(inner);
        el.appendChild(wrap);
      }
    });
  }
  el.dataset.gSplit = '1';
}

// ── Scrambler (free reveal effect for monospace numbers / labels) ──
function scrambleText(el, finalText, duration = 0.6) {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVXYZ';
  const len = finalText.length;
  const start = performance.now();
  const fps = 30;
  const frameDur = 1000 / fps;
  let last = 0;
  function tick(now) {
    const t = Math.min(1, (now - start) / (duration * 1000));
    if (now - last >= frameDur || t === 1) {
      let out = '';
      for (let i = 0; i < len; i++) {
        const reveal = t * len;
        if (i < reveal - 1) {
          out += finalText[i];
        } else if (finalText[i] === ' ' || finalText[i] === '.') {
          out += finalText[i];
        } else {
          out += chars[Math.floor(Math.random() * chars.length)];
        }
      }
      el.textContent = out;
      last = now;
    }
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = finalText;
  }
  requestAnimationFrame(tick);
}

// ── Main motion init (GSAP path) ──
function initMotion() {
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (!gsap || !ScrollTrigger) {
    initFallbackReveal();
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  // Defeat the CSS [data-animate] opacity:0 — we'll control reveal from JS.
  // (Adding this class on <html> flips a CSS rule that disables the base hidden state.)
  document.documentElement.classList.add('gsap-ready');

  gsap.defaults({ ease: 'power3.out', duration: 0.9 });

  // ── 1. Hero entrance (runs once, on load) ──
  const heroH1 = document.querySelector('.hero-grid h1, .page-hero h1');
  const heroEyebrow = document.querySelector(
    '.hero-grid .eyebrow, .page-hero .eyebrow'
  );
  const heroLede = document.querySelector(
    '.hero-grid .lede, .page-hero .lede'
  );
  const heroCta = document.querySelector(
    '.hero-grid .page-hero-cta, .page-hero .page-hero-cta'
  );
  const heroMeta = document.querySelector('.hero-grid .hero-meta');
  // Index has a 2-column hero with the figure in column 2.
  // Subpages have a separate <section> below page-hero containing the figure.
  const heroVisual =
    document.querySelector('.hero-grid [data-animate]:last-child .asset-shot') ||
    document.querySelector(
      'section[style*="padding-top:40px"] .asset-shot, section[style*="padding-top: 40px"] .asset-shot'
    );

  if (heroH1) {
    splitWords(heroH1);
    const words = heroH1.querySelectorAll('.g-word-inner');
    gsap.set(words, { yPercent: 110 });
  }
  if (heroEyebrow) gsap.set(heroEyebrow, { autoAlpha: 0, y: 8 });
  if (heroLede) gsap.set(heroLede, { autoAlpha: 0, y: 14 });
  if (heroCta) gsap.set(heroCta.children, { autoAlpha: 0, y: 14 });
  if (heroMeta) gsap.set(heroMeta.children, { autoAlpha: 0, y: 8 });
  if (heroVisual) gsap.set(heroVisual, { autoAlpha: 0, y: 30, scale: 0.985 });

  // Mark hero data-animate as visible so CSS doesn't fight us.
  document
    .querySelectorAll('.hero-grid [data-animate], .page-hero [data-animate]')
    .forEach((el) => el.classList.add('in-view'));
  // Same for the hero visual section if it's a separate data-animate.
  const heroFigure = document.querySelector(
    'section[style*="padding-top:40px"] [data-animate]'
  );
  if (heroFigure) heroFigure.classList.add('in-view');

  const heroTl = gsap.timeline({ delay: 0.12 });
  if (heroEyebrow) {
    heroTl.to(heroEyebrow, { autoAlpha: 1, y: 0, duration: 0.5 }, 0);
  }
  if (heroH1) {
    const words = heroH1.querySelectorAll('.g-word-inner');
    heroTl.to(
      words,
      { yPercent: 0, duration: 1.1, stagger: 0.045, ease: 'power4.out' },
      0.05
    );
  }
  if (heroLede) {
    heroTl.to(
      heroLede,
      { autoAlpha: 1, y: 0, duration: 0.7 },
      0.45
    );
  }
  if (heroCta) {
    heroTl.to(
      heroCta.children,
      { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.08 },
      0.55
    );
  }
  if (heroMeta) {
    heroTl.to(
      heroMeta.children,
      { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.06 },
      0.7
    );
  }
  if (heroVisual) {
    heroTl.to(
      heroVisual,
      { autoAlpha: 1, y: 0, scale: 1, duration: 1.1, ease: 'expo.out' },
      0.3
    );
  }

  // ── 2. Section label underline draw-in ──
  document.querySelectorAll('.section-label').forEach((el) => {
    // Replace the border-top with an inserted pseudo-line we can scale.
    const line = document.createElement('span');
    line.className = 'g-section-line';
    el.prepend(line);
    el.classList.add('g-no-border');
    gsap.set(line, { scaleX: 0, transformOrigin: 'left center' });
    gsap.set(el.querySelectorAll('.num, .title'), { autoAlpha: 0, y: 6 });
    ScrollTrigger.create({
      trigger: el,
      start: 'top 85%',
      once: true,
      onEnter: () => {
        const tl = gsap.timeline();
        tl.to(line, { scaleX: 1, duration: 0.9, ease: 'expo.out' }, 0);
        tl.to(
          el.querySelectorAll('.num, .title'),
          { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.06 },
          0.2
        );
      },
    });
  });

  // ── 3. Section head (h2 + lede) ──
  document.querySelectorAll('.section-head').forEach((el) => {
    const h2 = el.querySelector('h2');
    const lede = el.querySelector('.lede');
    if (h2) splitWords(h2);
    const words = h2 ? h2.querySelectorAll('.g-word-inner') : [];
    if (words.length) gsap.set(words, { yPercent: 110 });
    if (lede) gsap.set(lede, { autoAlpha: 0, y: 18 });
    el.classList.add('in-view');
    ScrollTrigger.create({
      trigger: el,
      start: 'top 80%',
      once: true,
      onEnter: () => {
        const tl = gsap.timeline();
        if (words.length) {
          tl.to(
            words,
            { yPercent: 0, duration: 0.95, stagger: 0.035, ease: 'power4.out' },
            0
          );
        }
        if (lede) tl.to(lede, { autoAlpha: 1, y: 0, duration: 0.7 }, 0.25);
      },
    });
  });

  // ── 4. Feature blocks (alternating side-by-side) ──
  document.querySelectorAll('.feature').forEach((el) => {
    const copy = el.querySelector('.feat-copy');
    const visual = el.querySelector('.feat-visual');
    const isReverse = el.classList.contains('reverse');
    if (copy) gsap.set(copy, { autoAlpha: 0, x: isReverse ? 40 : -40 });
    if (visual) gsap.set(visual, { autoAlpha: 0, x: isReverse ? -40 : 40 });
    el.querySelectorAll('[data-animate]').forEach((d) =>
      d.classList.add('in-view')
    );
    ScrollTrigger.create({
      trigger: el,
      start: 'top 78%',
      once: true,
      onEnter: () => {
        gsap.to([copy, visual].filter(Boolean), {
          autoAlpha: 1,
          x: 0,
          duration: 1,
          ease: 'expo.out',
          stagger: 0.08,
        });
      },
    });
  });

  // ── 5. Card grids ──
  document.querySelectorAll('.cards').forEach((grid) => {
    const cards = grid.children;
    if (!cards.length) return;
    gsap.set(cards, { autoAlpha: 0, y: 30 });
    grid.classList.add('in-view');
    ScrollTrigger.create({
      trigger: grid,
      start: 'top 82%',
      once: true,
      onEnter: () => {
        gsap.to(cards, {
          autoAlpha: 1,
          y: 0,
          duration: 0.7,
          stagger: { each: 0.06, from: 'start' },
          ease: 'power3.out',
        });
      },
    });
  });

  // ── 6. Agents grid (denser stagger, scale-in) ──
  document.querySelectorAll('.agents-grid').forEach((grid) => {
    const cards = grid.querySelectorAll('.agent-card');
    gsap.set(cards, { autoAlpha: 0, y: 20, scale: 0.94 });
    grid.classList.add('in-view');
    ScrollTrigger.create({
      trigger: grid,
      start: 'top 82%',
      once: true,
      onEnter: () => {
        gsap.to(cards, {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.55,
          stagger: { each: 0.035, from: 'start' },
          ease: 'back.out(1.4)',
        });
      },
    });
  });

  // ── 7. Asset shot subtle parallax (scrub) ──
  document.querySelectorAll('.asset-shot').forEach((shot) => {
    const media = shot.querySelector('img, video');
    if (!media) return;
    gsap.fromTo(
      media,
      { y: -28 },
      {
        y: 28,
        ease: 'none',
        scrollTrigger: {
          trigger: shot,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
        },
      }
    );
  });

  // ── 8. FIG.xx scramble on caption numbers ──
  document.querySelectorAll('figcaption .cap-num').forEach((el) => {
    const final = el.textContent;
    el.dataset.gFinal = final;
    ScrollTrigger.create({
      trigger: el,
      start: 'top 90%',
      once: true,
      onEnter: () => scrambleText(el, final, 0.55),
    });
  });

  // ── 9. Magnetic CTAs (btn-lg only — subtle, don't overdo) ──
  document.querySelectorAll('.btn-lg').forEach((btn) => {
    const xTo = gsap.quickTo(btn, 'x', { duration: 0.45, ease: 'power3.out' });
    const yTo = gsap.quickTo(btn, 'y', { duration: 0.45, ease: 'power3.out' });
    btn.addEventListener('mousemove', (e) => {
      const r = btn.getBoundingClientRect();
      const mx = e.clientX - (r.left + r.width / 2);
      const my = e.clientY - (r.top + r.height / 2);
      xTo(mx * 0.22);
      yTo(my * 0.32);
    });
    btn.addEventListener('mouseleave', () => {
      xTo(0);
      yTo(0);
    });
  });

  // ── 10. Marquee — GSAP-driven seamless loop (replaces CSS keyframe) ──
  document.querySelectorAll('.marquee-track').forEach((track) => {
    // Kill the CSS animation; we own it now.
    track.style.animation = 'none';
    // Build a continuous loop by translating by half the track width
    // (the track already duplicates its content in the markup).
    const setX = gsap.quickSetter(track, 'x', 'px');
    let trackWidth = track.scrollWidth / 2;
    let pos = 0;
    let speed = 40; // px / second — matches "40s" CSS duration over ~the same width.
    let last = performance.now();
    let paused = false;
    track.addEventListener('mouseenter', () => (paused = true));
    track.addEventListener('mouseleave', () => (paused = false));
    function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      if (!paused) {
        pos -= speed * dt;
        if (pos <= -trackWidth) pos += trackWidth;
        setX(pos);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    // Recompute on resize (icons may reflow).
    window.addEventListener('resize', () => {
      trackWidth = track.scrollWidth / 2;
    });
  });

  // ── 11. Manifesto closer — big-type entrance ──
  document.querySelectorAll('.manifesto').forEach((el) => {
    const h2 = el.querySelector('h2');
    const cap = el.querySelector('.m-caption');
    const cta = el.querySelector('.page-hero-cta');
    if (h2) splitWords(h2);
    const words = h2 ? h2.querySelectorAll('.g-word-inner') : [];
    if (words.length) gsap.set(words, { yPercent: 110 });
    if (cap) gsap.set(cap, { autoAlpha: 0, y: 18 });
    if (cta) gsap.set(cta.children, { autoAlpha: 0, y: 14 });
    el.classList.add('in-view');
    ScrollTrigger.create({
      trigger: el,
      start: 'top 75%',
      once: true,
      onEnter: () => {
        const tl = gsap.timeline();
        if (words.length) {
          tl.to(
            words,
            { yPercent: 0, duration: 1.15, stagger: 0.05, ease: 'expo.out' },
            0
          );
        }
        if (cap) tl.to(cap, { autoAlpha: 1, y: 0, duration: 0.75 }, 0.35);
        if (cta) {
          tl.to(
            cta.children,
            { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.08 },
            0.5
          );
        }
      },
    });
  });

  // ── 12. Page nav (prev / next) ──
  document.querySelectorAll('.page-nav a').forEach((a, i) => {
    gsap.set(a, { autoAlpha: 0, y: 24 });
    ScrollTrigger.create({
      trigger: a,
      start: 'top 90%',
      once: true,
      onEnter: () => {
        gsap.to(a, {
          autoAlpha: 1,
          y: 0,
          duration: 0.7,
          delay: i * 0.06,
          ease: 'power3.out',
        });
      },
    });
  });

  // ── 13. Catch-all for any remaining [data-animate] we haven't claimed ──
  // (cards / features / heros already added .in-view above; this picks up
  //  anything else — e.g. one-off divs on subpages.)
  document.querySelectorAll('[data-animate]:not(.in-view)').forEach((el) => {
    gsap.set(el, { autoAlpha: 0, y: 24 });
    el.classList.add('in-view');
    ScrollTrigger.create({
      trigger: el,
      start: 'top 85%',
      once: true,
      onEnter: () => {
        gsap.to(el, { autoAlpha: 1, y: 0, duration: 0.7 });
      },
    });
  });

  // Refresh ScrollTrigger after images load (avoids triggers anchored on
  // pre-load layout that shifts when images decode).
  window.addEventListener('load', () => ScrollTrigger.refresh());
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  if (reducedMotion) {
    initFallbackReveal();
    return;
  }
  // GSAP loads via <script> in <head>; by DOMContentLoaded it should be ready.
  if (window.gsap && window.ScrollTrigger) {
    initMotion();
  } else {
    // Defensive: if the CDN was slow, wait briefly then fall back.
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (window.gsap && window.ScrollTrigger) {
        clearInterval(t);
        initMotion();
      } else if (tries > 20) {
        clearInterval(t);
        initFallbackReveal();
      }
    }, 100);
  }
});
