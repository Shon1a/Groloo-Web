import { retainImage, isDecoded } from './useImageReady';
import { parallaxEnabled } from './tvMotionFlags';
import { glanceIconNode, type GlanceIconName } from '../components/glance/glanceSymbols';

/* THE ROW'S STAGE — everything a press changes on screen, written to the DOM directly.
 *
 * WHY THIS IS NOT REACT, AND IT IS A MEASUREMENT RATHER THAN A TASTE.
 *
 * A deliberate Right press on a home row used to be: setState, a React render of the whole row, a
 * commit, a passive-effect pass that started a swap gate, a SECOND commit when the gate opened (the
 * cross-fade layers are rendered from state), and a third effect pass that started the animations.
 * Driven on the desktop with the CPU slowed to the television's measured frame statistics (a 60Hz
 * panel, 14x), that chain scored 52-61% of frames on time, 12-14 dropped frames per press and a
 * 120-270ms worst frame.
 *
 * The SAME press, on the SAME DOM, the SAME CSS and the SAME animations — but written straight to
 * the nodes in the keydown task — scored 98-99% on time, 0.3-0.6 dropped frames per press and a 33ms
 * worst frame. Nothing about the choreography was the cost. The cost was running a renderer to
 * decide which of two stacked <div>s was in front.
 *
 * So the things a press changes — the two billboard layers and their plates, the copy underneath,
 * the sliver of the previous card at the screen edge — are owned HERE. React renders their empty
 * containers once and never touches their children again (a host element with no React children is
 * left alone by every later render), and TvSpotlight calls into this object from the key handler.
 * The poster strip keeps its React-rendered tile window: a tile is mounted several presses before it
 * can be seen, so it can be committed lazily and in slices without anyone noticing.
 *
 * RULES THIS FILE HOLDS TO:
 *   · NO LAYOUT READS on the press path. A read after a write forces a synchronous style + layout
 *     pass inside the key handler; every measurement here is taken once, off the press, and cached.
 *   · THE PRESS ONLY FLIPS. The next card is built BEFORE it is asked for (`prefill`, on an idle
 *     moment after the last press settled, in the direction the walk is going), so the press itself
 *     is a class swap and a handful of animations. Everything that costs real main-thread time — building
 *     nodes, shaping three lines of synopsis, an <img>'s `src` — is paid between presses, where the
 *     row is doing nothing. A press the prefill did not predict (the remote turned round) falls
 *     back to building the card inline, which is the old cost and no worse.
 *   · NO LAYER IS BUILT TWICE. A photograph that is already decoded is put on screen already
 *     `rdy`, so there is no opacity animation to start for the picture itself — the only things
 *     that animate on a press are the incoming layer (its opacity and its drift, ONE animation) and
 *     the copy (its opacity and its slide, ONE animation), plus the strip and the peek. A hold
 *     animates the layer, the strip and the peek, and writes no copy at all (see `show`).
 *   · EVERYTHING IS CANCELLED BY THE NEXT PRESS. A press that lands before the last one's
 *     animations have finished cancels them rather than queueing behind them.
 */

/* ---- THE MOTION CONSTANTS. They moved here from TvSpotlight with the code that uses them. -------
 * Their derivations (a 1080p30 capture of the reference, correlated frame by frame) are recorded in
 * tv.css next to the rules they mirror — `.tv-spot-strip` for the slide, `.tv-spot-layer` for the
 * dissolve, `.tv-spot-infoblk` for the copy. Change a number here and the matching rule there
 * together, or the pair goes out of step. */
/** A deliberate press: one poster pitch in 267ms on cubic-bezier(.33,1,.68,1). */
export const SLIDE_MS = 267;
/** A held key: a little LONGER than the 300ms pace, so a re-aimed transition never completes. */
export const HELD_SLIDE_MS = 340;
/* ---- THE DISSOLVE IS ONE ANIMATION, AND IT USED TO BE THREE ----------------------------------------
 * The incoming picture used to be two layers fading against each other on their own clocks (the
 * outgoing one collapsing in two frames, the incoming one rising linearly over 190ms — the "dark
 * trough" fitted from the reference), plus a third animation drifting the photograph 3.2% sideways.
 * Every animation costs the main thread a burst of style recalcs and commits at its start and again
 * at its end — measured at ~4ms of desktop CPU, ~55ms on the television, EACH, whatever it animates —
 * and a press ran seven of them.
 *
 * Now the INCOMING layer fades in over the outgoing one, which is held fully opaque beneath it until
 * the arrival has finished, and the drift is carried by the same animation (opacity and a translate
 * in one call). Three animations became one. What is given up is the trough: the picture hands over
 * monotonically, with no dip through the dark card between the two, which is what every ten-foot
 * interface that is not trying to copy a particular reference does, and is no less a dissolve.
 * The drift is the same 3.2% and the same ease-out; the opacity now follows that ease-out too
 * (one animation has one curve), so the picture is mostly there by the middle of the move. */
/** Every arrival — a deliberate press AND each step of a held key: the incoming layer's opacity and
 *  the 3.46% drift, on one curve.
 *
 *  A HOLD USED TO GET ITS OWN, and it read as a different, cheaper animation: 150ms, linear, no drift
 *  — a flat cross-fade three times a second, which is a flicker, where one press was a picture sliding
 *  in and settling. Same call now, so holding the key looks like pressing it, quickly. It costs a hold
 *  nothing: still the one animation per step, and the drift is a transform on the element that is
 *  already composited for the fade. 280ms fits inside the 300ms the hold walks at (HELD_STEP_MIN_MS in
 *  TvSpotlight), and this curve has the picture ~93% in by 120ms and ~99.9% by 250ms — so on a set slow
 *  enough that the next step lands first, all it can cut off is the last imperceptible fraction. */
const LAYER_IN_MS = 280;
const DRIFT_PRESS = 0.0346;
/** When the outgoing layer stops being needed, which is before the arrival's last frame: this curve is
 *  99.5% of the way at 200ms, so what the incoming layer still lets through of the one beneath is under
 *  1.3 levels of 8-bit brightness even between a white frame and a black one. Letting it go there frees
 *  that layer for the NEXT card with ~100ms of a held step still to run. Waiting for the finish left a
 *  hold none — 280ms of a 300ms pace — so the card was built inside the next key press instead: traced
 *  at the set's speed, +25% key handler CPU on average and spikes to four times the norm. */
const RELEASE_AT_MS = 200;
/** The copy's own arrival on a deliberate press: 4.6% of the billboard's width, 395ms quartic
 *  ease-out — its opacity rides the same curve now, for the reason above. */
const COPY_SLIDE_FRACTION = 0.046;
const COPY_IN_MS = 395;
/** When the LAST animation a deliberate press starts has finished (the copy's, the longest of them).
 *  Anything the row owes after a press that is not the press itself — React catching up with the walk,
 *  building the next card — is scheduled after this, so it never lands in the middle of a glide. */
export const PRESS_SETTLED_MS = Math.max(SLIDE_MS, LAYER_IN_MS, COPY_IN_MS);
/** The photograph's rise from the plate when it was NOT decoded in time, written to the hero as a
 *  custom property for `.art-photo`'s transition. */
export const ART_FADE_MS = 110;
export const ART_FADE_MS_CHAINED = 90;
/** How long the plate stays under a photograph that is still rising, and how long before a card
 *  with NO picture yet shows one at all (a picture a frame or two away never needed holding). */
const PLATE_HOLD_MS = 700;
const PLATE_DELAY_MS = 120;
/** How long after mounting the stage takes its one-off measurements — after the first paint. */
const MEASURE_AFTER_MOUNT_MS = 400;

/* `cubic-bezier(.33,1,.68,1)` — the strip's curve — evaluated, so the peek can continue a slide
 * from wherever it is without asking the engine (a getComputedStyle here is a forced style flush). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 6; i++) {
      const e = sx(t) - p;
      if (Math.abs(e) < 1e-4) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(t);
  };
}
const stripEase = bezier(0.33, 1, 0.68, 1);

/** What the billboard, its plate and the copy show for one stop of the walk. */
export interface StageSlot {
  /** Identity of everything the layer and plate paint. Two slots with one key paint identically. */
  key: string;
  kind: 'title' | 'end' | 'none';
  /** The photograph ('' until the row is near enough to be allowed one), its plate and its focus. */
  bgUrl: string;
  fallback: string;
  bgPos: string;
  /** The wordmark ('' falls back to the title in type). */
  logoUrl: string;
  title: string;
  /** Watch progress, 0..1, drawn as a bar across the foot of the billboard. */
  progress: number;
  /** The end card's own words. */
  endLabel: string;
  endIcon: string;
  /** A batch is in flight (OK was pressed on the "+" card): the stack's ring turns into a spinner. */
  endBusy: boolean;
  heading: string;
  /** The line of facts and the synopsis beneath. */
  meta: string[];
  plot: string;
  /** The title's at-a-glance callouts ("New Season", "#2 in Shows This Week"), at most two, for the
   *  billboard's bottom-right corner — the reference's place for them. */
  glance?: Array<{ icon: GlanceIconName; text: string; kind: string }>;
}

/** The card parked at the screen edge: its picture, where to seat it, and the plate behind it. */
export interface PeekArt { src: string; pos: string }
/** `art: null` is "nothing has been walked past" (the head of the row) and hides the sliver. */
export interface StagePeek { art: PeekArt | null; gradient: string }

export interface StageParts {
  hero: HTMLElement;
  strip: HTMLElement;
  layers: [HTMLElement, HTMLElement];
  plates: [HTMLElement, HTMLElement];
  infos: [HTMLElement, HTMLElement];
  prev: HTMLElement;
  prevTrack: HTMLElement;
}

export interface ShowOpts { dir: 1 | -1; held: boolean; animate: boolean }

const div = (cls: string): HTMLDivElement => {
  const d = document.createElement('div');
  d.className = cls;
  return d;
};
const span = (cls: string, text: string): HTMLSpanElement => {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
};
/** THE END CARD ON THE BILLBOARD — the front card of EndTile in TvSpotlight, filling the billboard,
 *  so the two share every rule in tv.css: the shine and the icon in its ring. Only the front card:
 *  the stack of cards after it is the strip's own end card, standing under the billboard with its
 *  cards showing past the billboard's right edge. No label either; the plate carries it. */
const endFront = (icon: string): HTMLSpanElement => {
  const ring = span('tv-end-ring', '');
  ring.appendChild(span('tv-spot-blank-ic', icon));
  const front = span('tv-end-front', '');
  front.setAttribute('aria-hidden', 'true');
  front.append(span('tv-end-sheen', ''), ring);
  return front;
};
const infoKeyOf = (slot: StageSlot): string => (slot.kind === 'title' ? `${slot.meta.join('\u0001')}\u0002${slot.plot}` : '');
/* THE CALLOUTS HAVE A KEY OF THEIR OWN, apart from the card's: they can arrive LATER than the card
 * (a title's awards come back after it has come to rest), and a change to them must touch the chips
 * and nothing else — re-filling the plate for it would re-decode the wordmark under the viewer. */
const glanceKeyOf = (slot: StageSlot): string => (slot.kind === 'title' && slot.glance?.length
  ? slot.glance.map((g) => `${g.kind}:${g.text}`).join('\u0001') : '');
const glanceChips = (list: NonNullable<StageSlot['glance']>): HTMLDivElement => {
  const box = div('gl-chips tv on-art');
  for (const g of list) {
    const chip = document.createElement('span');
    chip.className = `gl-chip k-${g.kind}`;
    chip.append(glanceIconNode(g.icon), span('', g.text));
    box.appendChild(chip);
  }
  return box;
};

export class TvRowStage {
  private p: StageParts;
  /** Which of the two cards (layer + plate) is `.on`. The copy blocks have their own index, `infoOn`. */
  private front: 0 | 1 = 0;
  private layerKey: [string, string] = ['', ''];
  /** Whether each layer holds the end card. The hero carries `is-end` while the front one does, so the
   *  focus ring can go round the stack's front card rather than the whole billboard (tv.css). */
  private endIn: [boolean, boolean] = [false, false];
  private infoKey: [string, string] = ['', ''];
  /** What each plate's callout chips are showing — see glanceKeyOf. */
  private glanceKey: [string, string] = ['', ''];
  /** Which copy block is `.on`. It follows `front` on every press but a HELD one, which leaves the copy
   *  alone (the stylesheet hides it while the key is down) and lets `settle` put the right one up. */
  private infoOn: 0 | 1 = 0;
  /** True while the visible copy block describes a card the walk has already left. */
  private infoStale = false;
  /** Bumped by every fill of a layer, so a late decode or timer from the previous fill can tell. */
  private fillId: [number, number] = [0, 0];
  private plateTimer: [number, number] = [0, 0];
  private anims: Animation[] = [];
  /** The outgoing layer, held opaque under the incoming one until that has (all but) arrived. */
  private holding: HTMLElement | null = null;
  /** The incoming layer's animation, read for how far it has got (see RELEASE_AT_MS). */
  private arrival: Animation | null = null;
  /** A prefill that came while its layer was still `holding` — run when that layer is let go. */
  private deferredPrefill: { slot: StageSlot; withInfo: boolean } | null = null;
  private deferredTimer = 0;
  private destroyed = false;
  /* Measured once, off the press path (see `measure`). */
  private wl = 0;
  private stride = 0;
  private resizeId = 0;
  /** Measure soon, but never inside the task that mounted or pressed: see `measureSoon`. */
  private measureSoon = (delay: number) => {
    window.clearTimeout(this.resizeId);
    this.resizeId = window.setTimeout(() => this.measure(), delay);
  };
  private onResize = () => this.measureSoon(150);
  /* The peek: two tiles, each holding one `.tv-spot-previmg` painted as a background (setting an
   * <img>'s `src` is a synchronous resource lookup, ~1ms on the television, per picture per press;
   * a background is a style write). */
  private peekImgs: HTMLElement[] = [];
  private peekCur: PeekArt = { src: '', pos: '50% 50%' };
  private peekAnim: Animation | null = null;
  private peekRun = { from: 0, end: 0, ms: 0, held: false };
  private peekShown = false;

  constructor(parts: StageParts) {
    this.p = parts;
    for (const t of Array.from(parts.prevTrack.querySelectorAll('.tv-spot-prevtile'))) {
      const im = div('tv-spot-previmg');
      t.replaceChildren(im);
      this.peekImgs.push(im);
    }
    window.addEventListener('resize', this.onResize);
    /* NOT HERE, NOT SYNCHRONOUSLY. A layout read in a layout effect forces a full style + layout pass
     * of everything mounted so far — and the next row's stage has dirtied the document again by the
     * time it asks, so nine rows forced nine passes: measured at startup on the set's speed, ~1s of a
     * 4s launch, inside `measure` alone. Taken after the first paint instead, when layout is clean
     * and the read is free. */
    this.measureSoon(MEASURE_AFTER_MOUNT_MS);
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener('resize', this.onResize);
    window.clearTimeout(this.resizeId);
    this.plateTimer.forEach((t) => window.clearTimeout(t));
    this.cancelAnims();
    this.peekAnim?.cancel();
  }

  /** Taken once and on resize — never on a press. A layout read after a write is the one thing this
   *  object promises not to do inside the key handler. */
  measure() {
    if (this.destroyed) return;
    this.wl = this.p.hero.offsetWidth;
    const t = this.p.prevTrack.children;
    if (t.length >= 2) {
      const s = (t[1] as HTMLElement).offsetLeft - (t[0] as HTMLElement).offsetLeft;
      this.stride = s > 0 ? s : this.stride;
    }
  }

  /** The held-key and deliberate timings that live in CSS, written where they are read — the hero
   *  for the photograph's rise, the strip for the slide — instead of on the section, where an
   *  inherited custom property invalidates the style of every element in the row. */
  setPace(held: boolean) {
    this.p.hero.style.setProperty('--sp-art-fade', `${held ? ART_FADE_MS_CHAINED : ART_FADE_MS}ms`);
    this.p.strip.style.setProperty('--sp-slide', `${held ? HELD_SLIDE_MS : SLIDE_MS}ms`);
  }

  /* ---- PUTTING A SLOT ON SCREEN ------------------------------------------------------------- */

  /** No animation: first paint, and a catalogue change (a page is not a walk). */
  cut(slot: StageSlot, peek: StagePeek) {
    this.cancelAnims();
    const f = this.front;
    const b = (1 - f) as 0 | 1;
    this.fillCard(f, slot);
    this.markEnd();
    if (this.infoOn !== f) this.flipInfo(f);
    this.infoStale = false;
    this.layerKey[b] = '';
    this.endIn[b] = false;
    this.infoKey[b] = '';
    this.glanceKey[b] = '';
    this.fillId[b]++;
    window.clearTimeout(this.plateTimer[b]);
    this.p.layers[b].replaceChildren();
    this.p.plates[b].replaceChildren();
    this.p.infos[b].replaceChildren();
    this.setPeek(peek, 1, false, false);
  }

  /** In place, no dissolve: the same card with new facts (artwork arrived, the row was reached).
   *  Returns whether the card actually changed — after a walk React catches up with a card the stage
   *  is already showing, and that must not count as news. */
  refresh(slot: StageSlot, peek: StagePeek): boolean {
    const f = this.front;
    let changed = false;
    if (this.layerKey[f] !== slot.key) {
      // The same card can be re-filled in place (its artwork arrived): its callouts only replay if they changed.
      const was = this.glanceKey[f];
      this.fillLayer(f, slot); this.fillPlate(f, slot);
      if (this.glanceKey[f] !== was) this.playChips(f);
      this.layerKey[f] = slot.key; this.markEnd(); changed = true;
    }
    /* THE CARD ON SHOW KEEPS THE CALLOUTS IT CAME UP WITH. Its awards come back a second after it comes
     * to rest and can outrank what is up — and swapping a chip under the viewer is a blink. Only a card
     * that had none gets its first ones now (with their arrival); the rest wait for its next showing. */
    else if (!this.glanceKey[f] && glanceKeyOf(slot)) { this.fillGlance(f, slot); this.playChips(f); changed = true; }
    /* NOT THE COPY WHILE A HOLD HAS LEFT IT FOR `settle`. React catches up with a hold every few steps,
     * and this used to write the synopsis for the card on screen each time — the dearest thing a step
     * can do, under a stylesheet that hides it, and the very work a hold is built to skip. Worse, it
     * cleared `infoStale`, so letting go found nothing owed and the copy came back without its arrival. */
    const ik = infoKeyOf(slot);
    const fi = this.infoOn;
    if (!this.infoStale && this.infoKey[fi] !== ik) { this.fillInfo(fi, slot); this.infoKey[fi] = ik; changed = true; }
    this.setPeek(peek, 1, false, false);
    return changed;
  }

  /** Build the card the walk is about to ask for, on the card that is not showing, WITHOUT flipping.
   *  Called on an idle moment; see the rules at the head of this file. `withInfo` is false during a
   *  hold, which is not going to show a copy block until the key is let go. */
  prefill(slot: StageSlot, withInfo = true) {
    const b = (1 - this.front) as 0 | 1;
    /* NEVER INTO A LAYER THAT IS STILL ON SCREEN. The card that is not showing is, for the length of an
     * arrival, the one being shown UNDERNEATH it (`holding`) — and a hold's prefill comes 120ms after its
     * step, mid-dissolve. Writing the next title into that layer put it on screen through the end of the
     * fade: captured frame by frame, a one-frame ghost of the NEXT picture at the end of nearly every held
     * step, and a one-frame dark dip when that picture was not decoded yet and the layer showed nothing at
     * all. That flicker is what a held walk looked like. So the fill waits until the layer can be let go
     * (RELEASE_AT_MS into the arrival) and a new press drops it. */
    if (this.holding === this.p.layers[b]) {
      const t = Number(this.arrival?.currentTime) || 0;
      if (t < RELEASE_AT_MS) {
        this.deferredPrefill = { slot, withInfo };
        window.clearTimeout(this.deferredTimer);
        this.deferredTimer = window.setTimeout(() => this.runDeferredPrefill(), RELEASE_AT_MS - t + 4);
        return;
      }
      this.letGo(this.holding);
    }
    if (this.layerKey[b] !== slot.key) { this.fillLayer(b, slot); this.fillPlate(b, slot); this.layerKey[b] = slot.key; }
    else if (this.glanceKey[b] !== glanceKeyOf(slot)) this.fillGlance(b, slot);
    if (!withInfo) return;
    const bi = (1 - this.infoOn) as 0 | 1;
    const ik = infoKeyOf(slot);
    if (this.infoKey[bi] !== ik) { this.fillInfo(bi, slot); this.infoKey[bi] = ik; }
  }

  /** Walk to a slot: the cards trade places (the stylesheet dissolves the layers), the incoming
   *  picture drifts in, the copy arrives, and the peek slides. All of it from this one call. */
  show(slot: StageSlot, peek: StagePeek, o: ShowOpts) {
    this.cancelAnims();
    const b = (1 - this.front) as 0 | 1;
    if (this.layerKey[b] !== slot.key) { this.fillLayer(b, slot); this.fillPlate(b, slot); this.layerKey[b] = slot.key; }
    else if (this.glanceKey[b] !== glanceKeyOf(slot)) this.fillGlance(b, slot);
    const outgoing = this.front;
    this.flip(b);
    /* The incoming card's callouts arrive with it (their icons move once). Not on a held walk — three
     * cards a second is no time to read them; `settle` plays the card the walk stops on. */
    this.quietChips(outgoing);
    if (o.held) this.quietChips(b);
    else this.playChips(b);
    /* A HELD KEY GETS THE SLIDE, THE DISSOLVE AND THE PEEK — AND NO COPY AT ALL. The synopsis under the
     * billboard is three lines of text that nobody can read at three cards a second, and putting it up
     * is the most expensive thing a step does on the television: new nodes, a first shaping of every
     * word (a 395-character synopsis measured ~290ms of layout at the set's speed — most of it one
     * emoji's font fallback), a class swap, an arrival animation. So a hold does none of it: the copy
     * is hidden by the stylesheet while the key is down and the block on screen is left alone. Letting
     * go calls `settle`, and the card the walk STOPPED on gets its copy with the full arrival. */
    if (o.held) {
      this.infoStale = true;
    } else {
      const bi = (1 - this.infoOn) as 0 | 1;
      const ik = infoKeyOf(slot);
      if (this.infoKey[bi] !== ik) { this.fillInfo(bi, slot); this.infoKey[bi] = ik; }
      this.flipInfo(bi);
      this.infoStale = false;
    }
    if (o.animate) {
      this.arrive(o.dir, outgoing);
      if (!o.held) this.arriveCopy(o.dir);
    }
    this.setPeek(peek, o.dir, o.held, o.animate);
  }

  /** The key was let go: put up the copy for the card the walk stopped on, with the arrival a deliberate
   *  press gets. Does nothing unless a hold left the copy stale. */
  settle(slot: StageSlot, dir: 1 | -1, animate: boolean) {
    if (!this.infoStale) return;
    this.infoStale = false;
    if (animate) this.playChips(this.front);
    const bi = (1 - this.infoOn) as 0 | 1;
    const ik = infoKeyOf(slot);
    if (this.infoKey[bi] !== ik) { this.fillInfo(bi, slot); this.infoKey[bi] = ik; }
    this.flipInfo(bi);
    if (animate) this.arriveCopy(dir);
  }

  private fillCard(i: 0 | 1, slot: StageSlot) {
    this.fillLayer(i, slot);
    this.fillPlate(i, slot);
    this.layerKey[i] = slot.key;
    this.fillInfo(i, slot);
    this.infoKey[i] = infoKeyOf(slot);
  }

  private flip(to: 0 | 1) {
    const from = (1 - to) as 0 | 1;
    const { layers, plates } = this.p;
    layers[to].classList.add('on');
    layers[to].setAttribute('aria-hidden', 'false');
    layers[from].classList.remove('on');
    layers[from].setAttribute('aria-hidden', 'true');
    plates[to].classList.add('on');
    plates[to].setAttribute('aria-hidden', 'false');
    plates[from].classList.remove('on');
    plates[from].setAttribute('aria-hidden', 'true');
    this.front = to;
    this.markEnd();
  }

  /** `is-end` on the billboard while the end card is the one on screen, and `is-end-on` on the strip in
   *  the same moment — the strip's end card is then the one under the billboard, and its stack, showing
   *  past the billboard's edge, takes the billboard's beat (tv.css). A toggle that changes nothing
   *  leaves the attribute alone, so a walk through titles costs no style work here. */
  private markEnd() {
    const on = this.endIn[this.front];
    this.p.hero.classList.toggle('is-end', on);
    this.p.strip.classList.toggle('is-end-on', on);
  }

  private flipInfo(to: 0 | 1) {
    const { infos } = this.p;
    infos[to].classList.add('on');
    infos[(1 - to) as 0 | 1].classList.remove('on');
    this.infoOn = to;
  }

  private cancelAnims() {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.arrival = null;
    if (this.holding) this.letGo(this.holding);
    this.deferredPrefill = null;
    window.clearTimeout(this.deferredTimer);
    this.deferredTimer = 0;
  }

  /** The outgoing layer leaves the screen: it is no longer held under the arrival. */
  private letGo(out: HTMLElement) {
    if (this.holding !== out) return;
    out.classList.remove('holding');
    this.holding = null;
  }

  private runDeferredPrefill() {
    this.deferredTimer = 0;
    const d = this.deferredPrefill;
    this.deferredPrefill = null;
    if (d && !this.destroyed) this.prefill(d.slot, d.withInfo);   // re-checks the arrival's progress
  }

  /* ---- THE ARRIVAL: the picture, then the copy -----------------------------------------------
   * One animation on the incoming layer (opacity and drift) and, on a deliberate press, one on the
   * incoming copy. They are started in the same call as the swap so picture and text read as one card
   * changing. WAAPI with no `fill`, so each ENDS: a held final frame stays "active" to the compositor
   * and makes it promote everything painted after it (see tv.css `.tv-spot.is-open .tv-spot-info`). */
  private arrive(dir: 1 | -1, outgoing: 0 | 1) {
    const drift = parallaxEnabled();
    const wl = this.wl || this.p.hero.offsetWidth;
    /* THE INCOMING CARD FADES IN OVER THE OUTGOING ONE, which stays fully opaque beneath it until the
     * arrival has all but finished (`.holding`, see tv.css) and is then simply let go — at the latest
     * when the animation ends, earlier if a prefill wants the layer (RELEASE_AT_MS). */
    const out = this.p.layers[outgoing];
    out.classList.add('holding');
    this.holding = out;
    const inc = this.p.layers[this.front];
    const a = inc.animate(
      drift
        ? [{ opacity: 0, transform: `translateX(${dir * wl * DRIFT_PRESS}px)` }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: LAYER_IN_MS, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    this.arrival = a;
    a.onfinish = () => {
      this.letGo(out);
      if (!this.deferredPrefill) return;
      /* In a task of its own: `finish` is dispatched inside a frame's animation step, and the build would
       * otherwise be styled, laid out and painted in that same frame, in the middle of a held slide. */
      window.clearTimeout(this.deferredTimer);
      this.deferredTimer = window.setTimeout(() => this.runDeferredPrefill(), 0);
    };
    a.oncancel = () => this.letGo(out);
    this.anims.push(a);
  }

  /** THE COPY: one animation, opacity and the slide together. The reference gives them their own curves
   *  (a quartic slide and a quadratic fade); one animation has one, and two animations cost twice as
   *  much main thread for a difference nobody reading a synopsis can see. */
  private arriveCopy(dir: 1 | -1) {
    const copy = this.p.infos[this.infoOn];
    if (!copy.childElementCount) return;
    const drift = parallaxEnabled();
    const wl = this.wl || this.p.hero.offsetWidth;
    this.anims.push(copy.animate(
      drift
        ? [{ opacity: 0, transform: `translateX(${dir * wl * COPY_SLIDE_FRACTION}px)` }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: COPY_IN_MS, easing: 'cubic-bezier(.25, 1, .5, 1)' },
    ));
  }

  /* ---- THE BILLBOARD LAYER -------------------------------------------------------------------
   * Built to match what FadeBg rendered, class for class: the harness and the stylesheet both read
   * `.tv-spot-art`, `.art-photo` and `.rdy` by name. */
  private fillLayer(i: 0 | 1, slot: StageSlot) {
    const layer = this.p.layers[i];
    const id = ++this.fillId[i];
    window.clearTimeout(this.plateTimer[i]);
    this.endIn[i] = slot.kind === 'end';
    if (slot.kind === 'none') { layer.replaceChildren(); return; }
    if (slot.kind === 'end') {
      /* THE LABEL FLIPPING TO "LOADING" IS NOT A NEW CARD. It changes the slot's key, so `refresh` comes
       * here for the card already on screen — and building it again would deal the stack out a second
       * time, under the press that asked for more. The stack is kept and only told it is busy. */
      const had = layer.firstElementChild;
      if (had instanceof HTMLElement && had.classList.contains('tv-spot-blank') && had.dataset.icon === slot.endIcon) {
        had.classList.toggle('is-busy', slot.endBusy);
        return;
      }
      const blank = div(slot.endBusy ? 'tv-spot-blank is-busy' : 'tv-spot-blank');
      blank.dataset.icon = slot.endIcon;
      blank.appendChild(endFront(slot.endIcon));
      layer.replaceChildren(blank);
      return;
    }
    const host = div('tv-spot-art');
    host.style.backgroundPosition = slot.bgPos;
    layer.replaceChildren(host);
    if (!slot.bgUrl) {
      /* No photograph yet. The plate holds the frame, but not at once — see PLATE_DELAY_MS. */
      this.plateTimer[i] = window.setTimeout(() => {
        if (this.fillId[i] === id) host.style.backgroundImage = slot.fallback;
      }, PLATE_DELAY_MS);
      return;
    }
    const photo = div('art-photo');
    photo.setAttribute('aria-hidden', 'true');
    photo.style.backgroundImage = `url('${slot.bgUrl}')`;
    photo.style.backgroundPosition = slot.bgPos;
    host.appendChild(photo);
    const img = retainImage(slot.bgUrl);
    if (isDecoded(img)) {
      /* ALREADY DECODED: on screen whole, with nothing left to rise — a new element has no "before"
       * style, so there is no transition to run and no plate to put under it. */
      photo.classList.add('rdy');
      return;
    }
    this.plateTimer[i] = window.setTimeout(() => {
      if (this.fillId[i] === id) host.style.backgroundImage = slot.fallback;
    }, PLATE_DELAY_MS);
    const ready = () => {
      if (this.destroyed || this.fillId[i] !== id) return;
      window.clearTimeout(this.plateTimer[i]);
      host.style.backgroundImage = slot.fallback;
      photo.classList.add('rdy');
      this.plateTimer[i] = window.setTimeout(() => {
        if (this.fillId[i] === id) host.style.backgroundImage = 'none';
      }, PLATE_HOLD_MS);
    };
    if (typeof img.decode === 'function') img.decode().then(ready, ready);
    else { img.addEventListener('load', ready, { once: true }); img.addEventListener('error', ready, { once: true }); }
  }

  private fillPlate(i: 0 | 1, slot: StageSlot) {
    this.fillPlateCard(i, slot);
    this.fillGlance(i, slot);
  }

  private fillPlateCard(i: 0 | 1, slot: StageSlot) {
    const plate = this.p.plates[i];
    if (slot.kind === 'none') { plate.replaceChildren(); return; }
    const card = div('tv-spot-card-in');
    if (slot.kind === 'end') {
      /* dark type: the end card is silver (tv.css) */
      card.classList.add('is-end');
      card.append(span('tv-spot-tag', slot.endLabel), span('tv-spot-cardtitle', slot.heading));
      plate.replaceChildren(card);
      return;
    }
    if (slot.logoUrl) {
      const im = document.createElement('img');
      im.className = 'tv-spot-logo';
      im.decoding = 'async';
      im.alt = slot.title;
      im.src = slot.logoUrl;
      if (isDecoded(retainImage(slot.logoUrl))) im.classList.add('rdy');
      else {
        const done = () => im.classList.add('rdy');
        im.addEventListener('load', done, { once: true });
        im.addEventListener('error', done, { once: true });
      }
      card.appendChild(im);
    } else {
      card.appendChild(span('tv-spot-cardtitle', slot.title));
    }
    plate.replaceChildren(card);
    if (slot.progress > 0.01) {
      const bar = document.createElement('span');
      bar.className = 'tv-spot-progress';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i');
      fill.style.width = `${(Math.min(slot.progress, 1) * 100).toFixed(1)}%`;
      bar.appendChild(fill);
      plate.appendChild(bar);
    }
  }

  /** The callout chips in a plate's bottom-right corner, written over whatever was there. Cheap: a
   *  handful of nodes, and none at all for the many titles that have no callout. */
  private fillGlance(i: 0 | 1, slot: StageSlot) {
    const plate = this.p.plates[i];
    plate.querySelector(':scope > .gl-chips')?.remove();
    const k = glanceKeyOf(slot);
    this.glanceKey[i] = k;
    if (k && slot.glance) plate.appendChild(glanceChips(slot.glance));
  }

  /** Plate `i`'s callouts play their arrival — the tab rises, the icon makes its move (glance.css
   *  `.rise` / `.gl-run`). Taking the classes off and putting them back is what restarts it. */
  private playChips(i: 0 | 1) {
    const box = this.p.plates[i].querySelector<HTMLElement>(':scope > .gl-chips');
    if (!box) return;
    /* THE FORCED LAYOUT ONLY WHEN THERE IS SOMETHING TO RESTART. Reading `offsetWidth` here makes the
     * engine style and lay out everything the press has just written, inside the key handler — on every
     * press, because this used to do it unconditionally. A walk never needs it: the incoming card's chips
     * were either built fresh (no classes yet) or quietened when that card last left the screen
     * (`quietChips`), so adding the classes is already a new start. Only replaying chips that are still
     * marked running — the card on show, when its row is entered again — has to take them off first. */
    if (box.classList.contains('gl-run') || box.classList.contains('rise')) {
      box.classList.remove('gl-run', 'rise');
      void box.offsetWidth;
    }
    box.classList.add('gl-run', 'rise');
  }
  private quietChips(i: 0 | 1) {
    this.p.plates[i].querySelector(':scope > .gl-chips')?.classList.remove('gl-run', 'rise');
  }
  /** The row was entered: the card on show plays its callouts' arrival. */
  playFront() { this.playChips(this.front); }

  /* ---- THE COPY ------------------------------------------------------------------------------ */
  private fillInfo(i: 0 | 1, slot: StageSlot) {
    const blk = this.p.infos[i];
    if (slot.kind !== 'title') { blk.replaceChildren(); return; }
    const meta = div('tv-spot-meta');
    for (const b of slot.meta) meta.appendChild(span('', b));
    if (slot.plot) {
      const p = document.createElement('p');
      p.className = 'tv-spot-plot';
      p.textContent = slot.plot;
      blk.replaceChildren(meta, p);
    } else blk.replaceChildren(meta);
  }

  /* ---- THE PEEK ------------------------------------------------------------------------------
   * The card just walked past, parked so only its trailing slice shows at the screen edge. It is a
   * two-tile track (the outgoing card and its replacement, in the strip's own order) translated by
   * one stride, so one card is always sliding out as the next slides in — a plain slice of the
   * rail, and a rail is never empty. A held key CONTINUES the slide from wherever it is; restarting
   * from the nominal start would throw the picture backwards by the part already travelled. */
  private setPeek(peek: StagePeek, dir: 1 | -1, held: boolean, animate: boolean) {
    const { prev, prevTrack } = this.p;
    const art = peek.art;
    if (!art) {
      if (this.peekShown) { prev.style.visibility = 'hidden'; this.peekShown = false; }
      this.peekCur = { src: '', pos: '50% 50%' };
      return;
    }
    if (!this.peekShown) { prev.style.visibility = ''; this.peekShown = true; }
    if (prev.style.background !== peek.gradient) prev.style.background = peek.gradient;
    const sd = String(dir);
    if (prev.style.getPropertyValue('--sp-dir') !== sd) prev.style.setProperty('--sp-dir', sd);
    if (this.peekCur.src === art.src && this.peekCur.pos === art.pos) return;
    const outgoing = this.peekCur;
    this.peekCur = art;
    const pair = dir > 0 ? [outgoing, art] : [art, outgoing];
    for (let k = 0; k < 2; k++) {
      const im = this.peekImgs[k];
      const a = pair[k];
      const bg = a && a.src ? `url('${a.src}')` : 'none';
      if (im.style.backgroundImage !== bg) im.style.backgroundImage = bg;
      const pos = a && a.src ? a.pos : '50% 50%';
      if (im.style.backgroundPosition !== pos) im.style.backgroundPosition = pos;
    }
    if (!animate || !art.src) { this.peekAnim?.cancel(); this.peekAnim = null; return; }
    const stride = this.stride;
    if (!(stride > 0)) { this.measureSoon(0); return; }   // pressed before the first measurement: this one is a cut
    const end = dir > 0 ? -stride : 0;
    let from = end + dir * stride;
    const live = this.peekAnim;
    if (live && live.playState === 'running') {
      const r = this.peekRun;
      const p = Math.min(1, (Number(live.currentTime) || 0) / (r.ms || 1));
      const cur = r.from + (r.end - r.from) * (r.held ? p : stripEase(p));
      from = cur + dir * stride;
      live.cancel();
    }
    const ms = held ? HELD_SLIDE_MS : SLIDE_MS;
    this.peekRun = { from, end, ms, held };
    this.peekAnim = prevTrack.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${end}px)` }],
      held ? { duration: ms, easing: 'linear' } : { duration: ms, easing: 'cubic-bezier(.33, 1, .68, 1)' },
    );
  }
}
