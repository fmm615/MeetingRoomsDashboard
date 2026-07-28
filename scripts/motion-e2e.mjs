import assert from "node:assert/strict";

const debugOrigin =
  process.env.BROWSER_DEBUG_ORIGIN || "http://127.0.0.1:9222";
const appOrigin = process.env.APP_ORIGIN || "http://127.0.0.1:8081";

class CDP {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description, predicate, timeout = 8000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await sleep(40);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last value: ${JSON.stringify(lastValue)}`,
  );
}

const pages = await fetch(`${debugOrigin}/json/list`).then((response) =>
  response.json(),
);
const page =
  pages.find(
    (item) => item.type === "page" && !item.url.startsWith("chrome://"),
  ) || pages.find((item) => item.type === "page");
assert.ok(page, "Chrome did not expose a page target.");

const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const browserErrors = [];
cdp.on("Runtime.exceptionThrown", (event) => {
  browserErrors.push(
    event.exceptionDetails.exception?.description ||
      event.exceptionDetails.text,
  );
});
cdp.on("Log.entryAdded", (event) => {
  if (event.entry.level === "error") browserErrors.push(event.entry.text);
});

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

async function setMotionPreference(value) {
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value }],
  });
}

async function setViewport(width, height, mobile = false) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

async function navigate(pathname) {
  await cdp.send("Page.bringToFront");
  await cdp.send("Page.navigate", { url: `${appOrigin}${pathname}` });
  await cdp.send("Page.bringToFront");
  await waitFor("four resolved room cards", () =>
    evaluate(
      "document.querySelectorAll('.room-card').length === 4 && " +
        "!document.querySelector('.room-availability')?.textContent.includes('Checking')",
    ),
  );
}

async function sample(selector) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    let x = 0;
    let y = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (style.transform && style.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(style.transform);
      x = matrix.m41;
      y = matrix.m42;
      scaleX = Math.hypot(matrix.m11, matrix.m12);
      scaleY = Math.hypot(matrix.m21, matrix.m22);
    }
    return {
      opacity: Number.parseFloat(style.opacity || "1"),
      visibility: style.visibility,
      transform: style.transform,
      x,
      y,
      scaleX,
      scaleY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      color: style.color
    };
  })()`);
}

function assertIdentityTransform(value, label, tolerance = 0.55) {
  assert.ok(value, `${label} was not found.`);
  assert.ok(Math.abs(value.x) <= tolerance, `${label} moved ${value.x}px on x.`);
  assert.ok(Math.abs(value.y) <= tolerance, `${label} moved ${value.y}px on y.`);
  assert.ok(
    Math.abs(value.scaleX - 1) <= 0.006,
    `${label} scaled to ${value.scaleX} on x.`,
  );
  assert.ok(
    Math.abs(value.scaleY - 1) <= 0.006,
    `${label} scaled to ${value.scaleY} on y.`,
  );
}

async function movePointerTo(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `Pointer target not found: ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
}

async function movePointerAway() {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });
}

async function pressEscape() {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}

function grouped(samples, key) {
  return samples.filter((entry) => entry.key === key);
}

function visible(samples) {
  return samples.filter(
    (entry) =>
      entry.visibility !== "hidden" && entry.width > 0 && entry.height > 0,
  );
}

await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: String.raw`
    (() => {
      window.__motionBoot = [];
      addEventListener("DOMContentLoaded", () => {
        const started = performance.now();
        const read = (element, key, time) => {
          if (!element) return;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          let x = 0;
          let y = 0;
          let scaleX = 1;
          let scaleY = 1;
          if (style.transform && style.transform !== "none") {
            const matrix = new DOMMatrixReadOnly(style.transform);
            x = matrix.m41;
            y = matrix.m42;
            scaleX = Math.hypot(matrix.m11, matrix.m12);
            scaleY = Math.hypot(matrix.m21, matrix.m22);
          }
          window.__motionBoot.push({
            key,
            time,
            opacity: Number.parseFloat(style.opacity || "1"),
            visibility: style.visibility,
            x,
            y,
            scaleX,
            scaleY,
            width: rect.width,
            height: rect.height
          });
        };
        const frame = (now) => {
          read(document.querySelector("[data-motion-page]"), "page", now - started);
          read(document.querySelector(".topbar"), "topbar", now - started);
          read(document.querySelector(".brand img"), "logo", now - started);
          document.querySelectorAll(".room-card").forEach((card, index) => {
            read(card, "room-" + index, now - started);
          });
          if (now - started < 700) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, { once: true });
    })();
  `,
});

try {
  await setViewport(1200, 900);
  await setMotionPreference("no-preference");
  await navigate("/book");
  await sleep(760);

  assert.equal(
    await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),
    false,
  );
  assert.equal(
    await evaluate(`(() => {
      const nodes = [document.documentElement, ...document.querySelectorAll("body *")];
      return nodes.some(node => Object.keys(node).some(key =>
        key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")
      ));
    })()`),
    true,
    "The interface is not React-owned.",
  );

  const boot = await evaluate("window.__motionBoot");
  const pageSamples = visible(grouped(boot, "page"));
  assert.ok(pageSamples.length > 2, "Page entrance was not sampled.");
  assert.ok(
    pageSamples.some((entry) => entry.opacity < 0.98 || entry.y > 0.25),
    "Page content did not receive a restrained entrance.",
  );
  assert.ok(
    Math.max(...pageSamples.map((entry) => entry.y)) <= 10.75,
    "Page entrance moved more than 10px.",
  );
  const pageFinal = pageSamples.at(-1);
  assert.ok(pageFinal.opacity >= 0.98 && Math.abs(pageFinal.y) <= 0.6);

  for (const key of ["topbar", "logo"]) {
    for (const entry of visible(grouped(boot, key))) {
      assertIdentityTransform(entry, `Permanent ${key}`);
    }
  }

  const roomFirstVisible = [];
  for (let index = 0; index < 4; index += 1) {
    const samples = visible(grouped(boot, `room-${index}`));
    assert.ok(samples.length > 2, `Room card ${index + 1} was not sampled.`);
    assert.ok(
      samples.some((entry) => entry.opacity < 0.98 || entry.y > 0.25),
      `Room card ${index + 1} did not enter subtly.`,
    );
    assert.ok(
      Math.max(...samples.map((entry) => entry.y)) <= 8.75,
      `Room card ${index + 1} moved more than 8px.`,
    );
    assert.ok(samples.at(-1).opacity >= 0.98);
    roomFirstVisible.push(
      samples.find((entry) => entry.opacity >= 0.1)?.time ?? samples[0].time,
    );
  }
  assert.ok(
    Math.max(...roomFirstVisible) - Math.min(...roomFirstVisible) <= 220,
    "Room-card stagger was too long.",
  );

  const guidelinesButton = ".guidelines-button";
  await evaluate(
    `document.querySelector(${JSON.stringify(guidelinesButton)}).focus(); document.querySelector(${JSON.stringify(guidelinesButton)}).click()`,
  );
  await sleep(24);
  const guidelinesEntering = await sample("#guidelines-drawer");
  assert.ok(
    Math.abs(guidelinesEntering.x) <= 34 &&
      (Math.abs(guidelinesEntering.x) > 0.3 ||
        guidelinesEntering.opacity < 0.98),
    "Desktop guidelines drawer did not use a restrained entrance.",
  );
  const overlayEntering = await sample("#guidelines-backdrop");
  assert.ok(overlayEntering.opacity < 0.98, "Guidelines overlay did not fade.");
  await sleep(300);
  assertIdentityTransform(
    await sample("#guidelines-drawer"),
    "Settled guidelines drawer",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.app-shell').hasAttribute('inert') && " +
        "document.querySelector('#guidelines-drawer').contains(document.activeElement)",
    ),
    true,
  );
  await pressEscape();
  assert.equal(
    await evaluate(
      "document.querySelector('#guidelines-drawer').hasAttribute('inert') && " +
        "document.activeElement.matches('.guidelines-button') && " +
        "!document.querySelector('.app-shell').hasAttribute('inert')",
    ),
    true,
  );
  await sleep(300);
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#guidelines-drawer')).visibility",
    ),
    "hidden",
  );

  const indicatorSelector = ".selected-date-indicator";
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(indicatorSelector)}).length`), 1);
  const initialIndicator = await sample(indicatorSelector);
  const nextDate = await evaluate(
    "document.querySelector('.date-card:not(:disabled):not(.selected)').dataset.date",
  );
  await evaluate(
    "document.querySelector('.date-card:not(:disabled):not(.selected)').click()",
  );
  const dateSamples = [];
  for (const delay of [16, 45, 70, 100]) {
    await sleep(delay);
    dateSamples.push(await sample(indicatorSelector));
  }
  await waitFor("second date selection", () =>
    evaluate(
      `document.querySelector('.date-card.selected')?.dataset.date === ${JSON.stringify(nextDate)}`,
    ),
  );
  const finalIndicator = dateSamples.at(-1);
  assert.ok(
    Math.abs(finalIndicator.left - initialIndicator.left) > 5,
    "Shared date indicator did not move.",
  );
  const minimumLeft = Math.min(initialIndicator.left, finalIndicator.left) - 2;
  const maximumLeft = Math.max(initialIndicator.left, finalIndicator.left) + 2;
  assert.ok(
    dateSamples.every(
      (entry) => entry.left >= minimumLeft && entry.left <= maximumLeft,
    ),
    "Shared date indicator overshot.",
  );
  await waitFor("availability refresh", () =>
    evaluate(
      "Boolean(document.querySelector('.select-room-button:not(:disabled)')) && " +
        "!document.querySelector('.room-availability')?.textContent.includes('Checking')",
    ),
  );

  const roomSelector = ".room-card:has(.select-room-button:not(:disabled))";
  await movePointerTo(roomSelector);
  await sleep(170);
  let hoveredRoom = await sample(roomSelector);
  if (Math.abs(hoveredRoom.y) < 0.1) {
    await movePointerAway();
    await sleep(24);
    await movePointerTo(roomSelector);
    await sleep(170);
    hoveredRoom = await sample(roomSelector);
  }
  if (Math.abs(hoveredRoom.y) < 0.1) {
    await evaluate(`document.querySelector(${JSON.stringify(roomSelector)})
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))`);
    await sleep(170);
    hoveredRoom = await sample(roomSelector);
  }
  const hoverCapable = await evaluate("matchMedia('(hover: hover)').matches");
  if (hoverCapable) {
    assert.ok(
      hoveredRoom.y <= -0.25 && hoveredRoom.y >= -2.35,
      `Room hover moved ${hoveredRoom.y}px.`,
    );
  } else {
    assert.ok(
      Math.abs(hoveredRoom.y) <= 0.55,
      "A no-hover device received room-card movement.",
    );
  }
  assert.ok(hoveredRoom.scaleX <= 1.011 && hoveredRoom.scaleY <= 1.011);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });

  await evaluate(
    "document.querySelector('.select-room-button:not(:disabled)').click()",
  );
  await waitFor("40 time slots", () =>
    evaluate("document.querySelectorAll('.time-slot').length === 40"),
  );
  const slotSelector = ".time-slot:not(:disabled)";
  await movePointerTo(slotSelector);
  await sleep(170);
  let hoveredSlot = await sample(slotSelector);
  if (Math.abs(hoveredSlot.y) < 0.1) {
    await movePointerAway();
    await sleep(24);
    await movePointerTo(slotSelector);
    await sleep(170);
    hoveredSlot = await sample(slotSelector);
  }
  if (Math.abs(hoveredSlot.y) < 0.1) {
    await evaluate(`document.querySelector(${JSON.stringify(slotSelector)})
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))`);
    await sleep(170);
    hoveredSlot = await sample(slotSelector);
  }
  if (hoverCapable) {
    assert.ok(
      hoveredSlot.y <= -0.15 && hoveredSlot.y >= -1.35,
      `Time-slot hover moved ${hoveredSlot.y}px.`,
    );
  } else {
    assert.ok(
      Math.abs(hoveredSlot.y) <= 0.55,
      "A no-hover device received time-slot movement.",
    );
  }
  await evaluate("document.querySelector('.time-slot:not(:disabled)').click()");
  assert.equal(
    await evaluate(
      "document.querySelector('.time-slot.selected')?.getAttribute('aria-pressed')",
    ),
    "true",
  );
  await sleep(170);
  const selectedSlot = await sample(".time-slot.selected");
  assert.ok(selectedSlot.scaleX <= 1.021 && selectedSlot.scaleY <= 1.021);
  assert.equal(selectedSlot.color, "rgb(255, 255, 255)");
  await evaluate(
    "document.querySelector('.duration-option:not(:disabled)').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#continue-button').disabled"),
    false,
  );

  await evaluate(
    "document.querySelector('#continue-button').focus(); document.querySelector('#continue-button').click()",
  );
  await sleep(24);
  const detailsEntering = await sample("#details-drawer");
  assert.ok(
    Math.abs(detailsEntering.x) <= 34 &&
      (Math.abs(detailsEntering.x) > 0.3 || detailsEntering.opacity < 0.98),
    "Details drawer did not enter from a restrained offset.",
  );
  await sleep(300);
  assertIdentityTransform(
    await sample("#details-drawer"),
    "Settled details drawer",
  );
  assert.equal(await evaluate("location.pathname"), "/book/details");
  assert.equal(
    await evaluate(
      "document.querySelector('.app-shell').hasAttribute('inert') && " +
        "document.querySelector('#details-drawer').contains(document.activeElement)",
    ),
    true,
  );

  await evaluate("document.querySelector('#booking-form').requestSubmit()");
  await waitFor("required form error", () =>
    evaluate(
      "document.querySelector('#form-error')?.textContent.includes('Enter who')",
    ),
  );
  const requiredError = await sample("#form-error");
  assert.ok(Math.abs(requiredError.x) <= 0.55);
  assert.ok(Math.abs(requiredError.y) <= 4.75);
  await sleep(190);
  assert.ok((await sample("#form-error")).opacity >= 0.98);
  await sleep(350);
  assert.equal(
    await evaluate(
      "document.querySelector('#form-error')?.textContent.includes('Enter who')",
    ),
    true,
    "Important validation error disappeared automatically.",
  );

  const buttonWidths = await evaluate(`(() => {
    const button = document.querySelector("#confirm-button");
    const label = button.querySelector(".button-label");
    const original = label.innerHTML;
    const idle = button.getBoundingClientRect().width;
    label.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>Creating booking';
    const loading = button.getBoundingClientRect().width;
    label.innerHTML = original;
    const restored = button.getBoundingClientRect().width;
    return { idle, loading, restored };
  })()`);
  assert.ok(
    Math.abs(buttonWidths.loading - buttonWidths.idle) <= 2 &&
      Math.abs(buttonWidths.restored - buttonWidths.idle) <= 2,
    "Confirm-button width changed for its loading content.",
  );

  await pressEscape();
  assert.equal(await evaluate("location.pathname"), "/book");
  assert.equal(
    await evaluate(
      "document.querySelector('#details-drawer').hasAttribute('inert') && " +
      "document.activeElement.id === 'continue-button'",
    ),
    true,
  );
  await movePointerAway();
  await sleep(750);
  assert.deepEqual(
    await evaluate(`document.getAnimations({ subtree: true })
      .filter(animation => animation.playState === "running")
      .map(animation => animation.effect?.target?.id || animation.effect?.target?.className || "unknown")`),
    [],
    "A decorative animation kept running after the interface settled.",
  );

  await setMotionPreference("reduce");
  await navigate("/book");
  await sleep(180);
  assert.equal(
    await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),
    true,
  );
  const reducedBoot = await evaluate("window.__motionBoot");
  for (const key of ["page", "room-0", "room-1", "room-2", "room-3"]) {
    for (const entry of visible(grouped(reducedBoot, key))) {
      assertIdentityTransform(entry, `Reduced-motion ${key}`);
    }
  }
  const reducedRoomSelector =
    ".room-card:has(.select-room-button:not(:disabled))";
  await movePointerTo(reducedRoomSelector);
  await sleep(120);
  assertIdentityTransform(
    await sample(reducedRoomSelector),
    "Reduced-motion room hover",
  );
  await evaluate(
    "document.querySelector('.guidelines-button').focus(); document.querySelector('.guidelines-button').click()",
  );
  await waitFor("reduced-motion drawer open", () =>
    evaluate(
      "document.querySelector('#guidelines-drawer').classList.contains('open')",
    ),
  );
  await sleep(16);
  assertIdentityTransform(
    await sample("#guidelines-drawer"),
    "Reduced-motion guidelines drawer",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#guidelines-drawer').getAttribute('aria-hidden') === 'false' && " +
        "document.querySelector('.app-shell').hasAttribute('inert') && " +
        "document.querySelector('#guidelines-title').tabIndex === -1",
    ),
    true,
  );
  await pressEscape();

  await setViewport(390, 844, true);
  await setMotionPreference("no-preference");
  await navigate("/book");
  await evaluate(
    "document.querySelector('[data-guidelines=\"quiet-pods\"]').click()",
  );
  await sleep(24);
  const mobileDrawer = await sample("#guidelines-drawer");
  assert.ok(Math.abs(mobileDrawer.x) <= 0.75);
  assert.ok(
    Math.abs(mobileDrawer.y) <= 42 &&
      (Math.abs(mobileDrawer.y) > 0.3 || mobileDrawer.opacity < 0.98),
    "Mobile guidelines sheet did not enter from a restrained vertical offset.",
  );
  await sleep(300);
  assertIdentityTransform(
    await sample("#guidelines-drawer"),
    "Settled mobile guidelines sheet",
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
  );
  await pressEscape();
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] });

  assert.deepEqual([...new Set(browserErrors)], []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "React and Framer Motion client loads without browser errors",
          "subtle page and room-card entrance with static topbar and logo",
          "desktop and mobile guidelines drawer motion",
          "shared selected-date layout indicator",
          "room-card and time-slot hover/selection limits",
          "details drawer focus, inert state, and route restoration",
          "persistent non-shaking errors and stable loading-button width",
          "reduced motion removes translation and scale",
          "no continuous decorative animation after settling",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp
    .send("Emulation.setEmulatedMedia", { media: "", features: [] })
    .catch(() => {});
  cdp.close();
}
