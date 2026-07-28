import assert from "node:assert/strict";

const debugOrigin = process.env.BROWSER_DEBUG_ORIGIN || "http://127.0.0.1:9222";
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
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
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

async function waitFor(expression, evaluate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const pages = await fetch(`${debugOrigin}/json/list`).then(response => response.json());
const page = pages.find(item => item.type === "page" && !item.url.startsWith("chrome://")) ||
  pages.find(item => item.type === "page");
assert.ok(page, "Chrome did not expose a page target.");

const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();
const browserErrors = [];
cdp.on("Runtime.exceptionThrown", event => browserErrors.push(event.exceptionDetails.text));
cdp.on("Log.entryAdded", event => {
  if (event.entry.level === "error") browserErrors.push(event.entry.text);
});
cdp.on("Page.javascriptDialogOpening", () => {
  cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(error => browserErrors.push(error.message));
});
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
await cdp.send("Page.bringToFront");
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await cdp.send("Emulation.clearDeviceMetricsOverride");

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function clickCenter(selector) {
  const point = await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const bounds = target.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2
    };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

try {
await cdp.send("Page.navigate", { url: `${appOrigin}/book` });
await waitFor("document.querySelectorAll('.room-card').length === 4 && !document.querySelector('.room-availability')?.textContent.includes('Checking')", evaluate);
const desktopViewportWidth = await evaluate("innerWidth");
assert.equal(await evaluate("document.querySelectorAll('.date-card').length"), 5);
assert.equal(
  await evaluate("document.querySelectorAll('.date-card.weekend:disabled').length"),
  2,
);
assert.equal(
  await evaluate(
    "[...document.querySelectorAll('.date-card.weekend')].every(button => button.textContent.includes('Unavailable') && button.getAttribute('aria-label').includes('weekend unavailable'))",
  ),
  true,
);
assert.equal(await evaluate("document.querySelector('#details-drawer').hasAttribute('inert')"), true);
assert.equal(await evaluate("document.querySelector('#guidelines-drawer').hasAttribute('inert')"), true);
assert.equal(await evaluate("[...document.querySelectorAll('.date-card')].every(button => button.dataset.date <= document.querySelector('#date-input').max)"), true);
await evaluate(`(() => {
  const input = document.querySelector('#date-input');
  window.__otherDatePickerCalls = 0;
  Object.defineProperty(input, 'showPicker', {
    configurable: true,
    value: () => { window.__otherDatePickerCalls += 1; }
  });
})()`);
await clickCenter(".date-picker");
await waitFor(
  "window.__otherDatePickerCalls === 1 && document.activeElement.id === 'date-input'",
  evaluate,
);
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
});
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
});
await waitFor("window.__otherDatePickerCalls === 2", evaluate);
await evaluate(`(() => {
  const input = document.querySelector('#date-input');
  delete input.showPicker;
  delete window.__otherDatePickerCalls;
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  ).set;
  valueSetter.call(input, input.max);
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(
  "document.querySelector('.date-card.selected')?.dataset.date === document.querySelector('#date-input').max",
  evaluate,
);
assert.equal(
  await evaluate("document.querySelector('.date-card:last-child').dataset.date"),
  await evaluate("document.querySelector('#date-input').max"),
);
const weekendDate = await evaluate(
  "document.querySelector('.date-card.weekend').dataset.date",
);
await evaluate(`(() => {
  const input = document.querySelector('#date-input');
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  ).set;
  valueSetter.call(input, ${JSON.stringify(weekendDate)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(
  "document.querySelector('#toast')?.textContent.includes('Fridays and Saturdays')",
  evaluate,
);
assert.equal(
  await evaluate("document.querySelector('.date-card.selected').dataset.date"),
  await evaluate("document.querySelector('#date-input').max"),
);
assert.deepEqual(
  await evaluate("[...document.querySelectorAll('.room-card h3')].map(node => node.textContent)"),
  ["Meeting Room", "Standing Workstations", "Innovation Hub", "Quiet Pods"]
);

await evaluate("document.querySelector('[data-guidelines=\"meeting-a\"]').click()");
await waitFor("document.querySelector('#guidelines-drawer').classList.contains('open') && document.activeElement.id === 'guidelines-title'", evaluate);
assert.equal(await evaluate("document.querySelector('.app-shell').hasAttribute('inert')"), true);
assert.equal(await evaluate("document.querySelector('#guidelines-body').textContent.includes('Middle Meeting Room')"), false);
assert.equal(await evaluate("document.querySelector('#guidelines-body').textContent.includes('Brief check-ins')"), true);
assert.equal(await evaluate("document.querySelector('#guidelines-body').textContent.includes('15, 30, 45, or 60 minutes')"), true);
await evaluate("document.querySelector('#done-guidelines').click()");
await waitFor("document.querySelector('#guidelines-drawer').hasAttribute('inert')", evaluate);
assert.equal(await evaluate("document.activeElement.matches('[data-guidelines=\"meeting-a\"]')"), true);

const nextDate = await evaluate(
  "document.querySelector('.date-card:not(:disabled):not(.selected)').dataset.date",
);
await evaluate(
  "document.querySelector('.date-card:not(:disabled):not(.selected)').click()",
);
await waitFor(
  `document.querySelector('.date-card.selected')?.dataset.date === ${JSON.stringify(nextDate)}`,
  evaluate,
);
const selectedDate = await evaluate("document.querySelector('.date-card.selected').dataset.date");
const rescheduledDateValue = new Date(`${selectedDate}T12:00:00Z`);
rescheduledDateValue.setUTCDate(rescheduledDateValue.getUTCDate() + 1);
const rescheduledDate = rescheduledDateValue.toISOString().slice(0, 10);
await waitFor("!document.querySelector('.room-availability')?.textContent.includes('Checking')", evaluate);
await evaluate("document.querySelector('[data-room=\"meeting-a\"]').click()");
await waitFor("document.querySelectorAll('.time-slot').length === 40", evaluate);
assert.equal(await evaluate("document.querySelector('.time-slot[data-slot=\"1\"]').textContent"), "8:15 AM");
await evaluate("document.querySelector('.time-slot[data-slot=\"5\"]').click()");
await waitFor("document.querySelectorAll('.duration-option').length === 4", evaluate);
await evaluate("document.querySelector('.duration-option[data-duration=\"45\"]').click()");
assert.equal(await evaluate("document.querySelectorAll('.time-slot.selected').length"), 1);
assert.equal(await evaluate("document.querySelector('.duration-option.selected').dataset.duration"), "45");
assert.equal(await evaluate("document.querySelector('#continue-button').disabled"), false);

await evaluate("document.querySelector('#continue-button').click()");
await waitFor("document.querySelector('#details-drawer').classList.contains('open')", evaluate);
assert.equal(await evaluate("location.pathname"), "/book/details");
assert.equal(await evaluate("document.querySelector('.app-shell').hasAttribute('inert')"), true);
assert.equal(await evaluate("document.querySelector('#drawer-summary').textContent.includes('Standing Workstations')"), true);
assert.equal(await evaluate("document.querySelector('#drawer-summary').textContent.includes('Middle Meeting Room')"), true);
assert.equal(await evaluate("document.querySelector('#drawer-summary').textContent.includes('45 minutes')"), true);
assert.equal(await evaluate("document.querySelector('#room-reminder').textContent.includes('15, 30, 45, or 60 minutes')"), true);
await evaluate(`
  (() => {
    const form = document.querySelector('#booking-form');
    form.elements.name.value = 'QA User';
    form.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
    form.elements.title.value = 'End-to-end review';
    form.elements.notes.value = 'Automated browser verification';
    form.requestSubmit();
  })()
`);
await waitFor("location.pathname.startsWith('/booking/') && document.querySelector('#confirmation-title')?.textContent === 'Booking confirmed'", evaluate);

const managementPath = await evaluate("location.pathname");
const token = managementPath.split("/").pop();
assert.match(token, /^[a-f0-9]{48}$/);
assert.match(await evaluate("document.querySelector('.reference strong').textContent"), /^PB-[A-F0-9]{16}$/);
assert.equal(await evaluate("document.querySelector('#private-link-input').value"), `${appOrigin}${managementPath}`);
assert.equal(await evaluate("document.querySelector('.confirmation-details').textContent.includes('Standing Workstations')"), true);
assert.equal(await evaluate("document.querySelector('.confirmation-details').textContent.includes('Middle Meeting Room')"), true);
assert.equal(await evaluate("document.querySelector('.confirmation-details').textContent.includes('Duration: 45 minutes')"), true);
assert.equal(await evaluate("[...document.querySelectorAll('h1')].filter(heading => heading.offsetParent !== null).length"), 1);
assert.equal(await evaluate("document.querySelector('#details-drawer').hasAttribute('inert')"), true);

let availability = await fetch(`${appOrigin}/api/availability?date=${selectedDate}&room=meeting-a`).then(response => response.json());
assert.deepEqual(availability.busy, [{ room: "meeting-a", start: 5, end: 8, type: "booked" }]);

await evaluate("document.querySelector('#edit-booking').click()");
await waitFor("document.querySelector('#details-drawer').classList.contains('open')", evaluate);
assert.equal(await evaluate("document.querySelector('#booking-form').elements.title.value"), "End-to-end review");
assert.equal(await evaluate("document.activeElement.id"), "edit-date");
assert.equal(await evaluate("document.querySelector('#edit-start').value"), "5");
assert.equal(await evaluate("document.querySelector('#edit-duration').value"), "45");
await evaluate(`(() => {
  const input = document.querySelector('#edit-date');
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  ).set;
  valueSetter.call(input, ${JSON.stringify(rescheduledDate)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(
  `document.querySelector('#edit-date').value === ${JSON.stringify(rescheduledDate)} && !document.querySelector('#edit-start').disabled`,
  evaluate,
);
assert.equal(await evaluate("document.querySelector('#booking-form').elements.name.value"), "QA User");
assert.equal(await evaluate("document.querySelector('#booking-form').elements.title.value"), "End-to-end review");
assert.equal(await evaluate("document.querySelector('#booking-form').elements.notes.value"), "Automated browser verification");
await evaluate(`(() => {
  const start = document.querySelector('#edit-start');
  start.value = '10';
  start.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor(
  "document.querySelector('#edit-start').value === '10' && !document.querySelector('#edit-duration').disabled",
  evaluate,
);
await evaluate(`(() => {
  const duration = document.querySelector('#edit-duration');
  duration.value = '30';
  duration.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor(
  "document.querySelector('#edit-duration').value === '30' && !document.querySelector('#confirm-button').disabled",
  evaluate,
);
assert.equal(
  await evaluate("document.querySelector('#drawer-summary').textContent.includes('10:30 AM–11:00 AM')"),
  true,
);
assert.equal(
  await evaluate("document.querySelector('#drawer-summary').textContent.includes('30 minutes')"),
  true,
);
await evaluate(`
  (() => {
    const form = document.querySelector('#booking-form');
    form.elements.title.value = 'Updated end-to-end review';
    form.requestSubmit();
  })()
`);
await waitFor("document.querySelector('.confirmation-details')?.textContent.includes('Updated end-to-end review')", evaluate);
assert.equal(await evaluate("location.pathname"), managementPath);
assert.equal(await evaluate("document.querySelector('#booking-view').classList.contains('hidden')"), true);
assert.equal(
  await evaluate("document.querySelector('.confirmation-details').textContent.includes('10:30 AM–11:00 AM')"),
  true,
);
assert.equal(
  await evaluate("document.querySelector('.confirmation-details').textContent.includes('Duration: 30 minutes')"),
  true,
);
availability = await fetch(`${appOrigin}/api/availability?date=${selectedDate}&room=meeting-a`).then(response => response.json());
assert.deepEqual(availability.busy, []);
availability = await fetch(`${appOrigin}/api/availability?date=${rescheduledDate}&room=meeting-a`).then(response => response.json());
assert.deepEqual(availability.busy, [{ room: "meeting-a", start: 10, end: 12, type: "booked" }]);

await evaluate("document.querySelector('#cancel-booking').click()");
await waitFor("document.querySelector('#confirmation-title')?.textContent.includes('cancelled')", evaluate);
availability = await fetch(`${appOrigin}/api/availability?date=${rescheduledDate}&room=meeting-a`).then(response => response.json());
assert.deepEqual(availability.busy, []);

await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true
});
await cdp.send("Page.navigate", { url: `${appOrigin}/book` });
await waitFor("document.querySelectorAll('.room-card').length === 4 && !document.querySelector('.room-availability')?.textContent.includes('Checking')", evaluate);
assert.equal(await evaluate("innerWidth"), 390);
assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
assert.equal(await evaluate("getComputedStyle(document.querySelector('.date-panel .section-heading')).flexDirection"), "column");
assert.equal(await evaluate("getComputedStyle(document.querySelector('.room-grid')).gridTemplateColumns.split(' ').length"), 1);
await evaluate("document.querySelector('[data-guidelines=\"quiet-pods\"]').click()");
await waitFor("document.querySelector('#guidelines-drawer').classList.contains('open')", evaluate);
assert.equal(await evaluate("getComputedStyle(document.querySelector('#guidelines-drawer')).bottom"), "0px");
assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
await evaluate("document.querySelector('#close-guidelines').click()");
await cdp.send("Emulation.clearDeviceMetricsOverride");
await waitFor(`innerWidth === ${desktopViewportWidth}`, evaluate);

assert.deepEqual(browserErrors, []);
console.log(JSON.stringify({
  passed: true,
  route: managementPath,
  checks: [
    "four canonical room cards and availability labels",
    "Other date invokes the native date picker",
    "guidelines content, focus, and restoration",
    "15-minute start and room-specific duration selection",
    "details route, summary, and room reminder",
    "booking creation",
    "Slack-compatible room, location, duration, and private reference",
    "same-route date, start-time, and duration rescheduling",
    "edit keeps booking details and moves availability to the new schedule",
    "cancellation frees availability",
    "390px stacked cards and bottom-sheet guidelines without overflow",
    "desktop viewport restored after mobile coverage",
    "no browser exceptions"
  ]
}, null, 2));
} finally {
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
  cdp.close();
}
