const DOM_HELPER_CHANNEL = "space.web_browsing.browser_frame.dom_helper";
const DOM_HELPER_FLAG = "__spaceBrowserDomHelperInstalled__";
const DOM_HELPER_KEY = "__spaceBrowserDomHelper__";
const DOM_HELPER_TIMEOUT_MS = 500;

function installBrowserDomHelper(flagKey = DOM_HELPER_FLAG, helperKey = DOM_HELPER_KEY, channel = DOM_HELPER_CHANNEL, timeoutMs = DOM_HELPER_TIMEOUT_MS) {
  if (globalThis[flagKey]) {
    return;
  }

  const INTERACTIVE_ROLES = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox"
  ]);
  const STRUCTURAL_ROLES = new Set([
    "alertdialog",
    "article",
    "banner",
    "complementary",
    "contentinfo",
    "dialog",
    "document",
    "form",
    "group",
    "main",
    "navigation",
    "none",
    "presentation",
    "region"
  ]);
  const INTERACTIVE_EVENT_NAMES = new Set([
    "auxclick",
    "change",
    "click",
    "contextmenu",
    "dblclick",
    "input",
    "keydown",
    "keypress",
    "keyup",
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
    "submit",
    "touchend",
    "touchstart"
  ]);
  const INTERACTIVE_EVENT_PROPERTIES = [...INTERACTIVE_EVENT_NAMES]
    .map((eventName) => `on${eventName}`);
  const SKIP_TAGS = new Set([
    "HEAD",
    "LINK",
    "META",
    "NOSCRIPT",
    "SCRIPT",
    "STYLE",
    "TEMPLATE"
  ]);
  const VOID_TAGS = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
  ]);

  const childFramesById = new Map();
  const elementsByNodeId = new Map();
  const nodeIdsByElement = new WeakMap();
  const pendingRequests = new Map();
  const requestTimeoutMs = Math.max(100, Number(timeoutMs) || DOM_HELPER_TIMEOUT_MS);
  const helperFrameId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `space-browser-frame-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let nextNodeId = 1;
  let nextRequestId = 1;

  if (typeof globalThis.Element?.prototype?.attachShadow === "function" && !globalThis.__spaceBrowserDomHelperShadowRootOverrideInstalled__) {
    const originalAttachShadow = globalThis.Element.prototype.attachShadow;
    globalThis.Element.prototype.attachShadow = function attachShadow(options) {
      const shadowOptions = options && typeof options === "object"
        ? { ...options, mode: "open" }
        : { mode: "open" };

      return originalAttachShadow.call(this, shadowOptions);
    };
    globalThis.__spaceBrowserDomHelperShadowRootOverrideInstalled__ = true;
  }

  function createNamedError(name, message, details = {}) {
    const error = new Error(message);
    error.name = name;
    Object.assign(error, details);
    return error;
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function normalizeAttributeText(value) {
    return normalizeText(value).slice(0, 160);
  }

  function getAttributeNamesSafe(element) {
    try {
      if (typeof element?.getAttributeNames === "function") {
        return element.getAttributeNames();
      }

      return [...(element?.attributes || [])]
        .map((attribute) => String(attribute?.name || "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function normalizeInteractiveEventName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .split(/[.:]/u, 1)[0];
  }

  function isInteractiveEventName(value) {
    return INTERACTIVE_EVENT_NAMES.has(normalizeInteractiveEventName(value));
  }

  function isInteractiveEventAttributeName(attributeName) {
    const normalizedName = String(attributeName || "").trim().toLowerCase();
    if (!normalizedName) {
      return false;
    }

    if (normalizedName.startsWith("@")) {
      return isInteractiveEventName(normalizedName.slice(1));
    }

    if (normalizedName.startsWith("x-on:") || normalizedName.startsWith("v-on:")) {
      return isInteractiveEventName(normalizedName.slice(5));
    }

    if (normalizedName.startsWith("ng-")) {
      return isInteractiveEventName(normalizedName.slice(3));
    }

    if (normalizedName.startsWith("on") && normalizedName.length > 2) {
      return isInteractiveEventName(normalizedName.slice(2));
    }

    return false;
  }

  function hasInteractiveEventHandlerAttribute(element) {
    return getAttributeNamesSafe(element).some((attributeName) => {
      return isInteractiveEventAttributeName(attributeName);
    });
  }

  function hasInteractiveEventHandlerProperty(element) {
    return INTERACTIVE_EVENT_PROPERTIES.some((propertyName) => {
      return typeof element?.[propertyName] === "function";
    });
  }

  function hasInteractiveEventHandler(element) {
    return hasInteractiveEventHandlerAttribute(element) || hasInteractiveEventHandlerProperty(element);
  }

  function truncateText(value, maxLength = 120) {
    const normalizedValue = normalizeText(value);
    if (normalizedValue.length <= maxLength) {
      return normalizedValue;
    }

    return `${normalizedValue.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
  }

  function escapeHtmlText(value) {
    return String(value ?? "")
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;");
  }

  function escapeHtmlAttribute(value) {
    return escapeHtmlText(value)
      .replace(/"/gu, "&quot;")
      .replace(/'/gu, "&#39;");
  }

  function isElementNode(value) {
    return Boolean(value && value.nodeType === 1);
  }

  function isTextNode(value) {
    return Boolean(value && value.nodeType === 3);
  }

  function getTagName(element) {
    return String(element?.tagName || "").toUpperCase();
  }

  function isStyleDeclarationHidden(styleValue) {
    const normalizedStyleValue = String(styleValue || "")
      .toLowerCase()
      .replace(/\s+/gu, "");

    if (!normalizedStyleValue) {
      return false;
    }

    return /(?:^|;)display:none(?:;|$)/u.test(normalizedStyleValue)
      || /(?:^|;)visibility:hidden(?:;|$)/u.test(normalizedStyleValue)
      || /(?:^|;)visibility:collapse(?:;|$)/u.test(normalizedStyleValue)
      || /(?:^|;)content-visibility:hidden(?:;|$)/u.test(normalizedStyleValue)
      || /(?:^|;)opacity:0(?:\.0+)?(?:;|$)/u.test(normalizedStyleValue);
  }

  function isComputedStyleHidden(computedStyle) {
    if (!computedStyle) {
      return false;
    }

    const display = normalizeText(computedStyle.display).toLowerCase();
    const visibility = normalizeText(computedStyle.visibility).toLowerCase();
    const contentVisibility = normalizeText(computedStyle.contentVisibility).toLowerCase();
    const opacity = Number(computedStyle.opacity || 1);

    return display === "none"
      || visibility === "hidden"
      || visibility === "collapse"
      || contentVisibility === "hidden"
      || opacity <= 0;
  }

  function isEffectivelyHiddenByAncestor(element) {
    let current = element;

    while (isElementNode(current)) {
      if (current.hidden || current.getAttribute?.("aria-hidden") === "true") {
        return true;
      }

      if (isStyleDeclarationHidden(current.getAttribute?.("style"))) {
        return true;
      }

      if (isComputedStyleHidden(getComputedStyleSafe(current))) {
        return true;
      }

      current = current.parentElement;
    }

    return false;
  }

  function isHiddenElement(element) {
    if (!isElementNode(element)) {
      return true;
    }

    const tagName = getTagName(element);
    if (SKIP_TAGS.has(tagName)) {
      return true;
    }

    if (element.hidden || element.getAttribute?.("aria-hidden") === "true") {
      return true;
    }

    if (tagName === "INPUT" && String(element.getAttribute?.("type") || "").toLowerCase() === "hidden") {
      return true;
    }

    if (isStyleDeclarationHidden(element.getAttribute?.("style"))) {
      return true;
    }

    const computedStyle = getComputedStyleSafe(element);
    if (isComputedStyleHidden(computedStyle)) {
      return true;
    }

    return isEffectivelyHiddenByAncestor(element.parentElement);
  }

  function isActionableElement(element) {
    if (!isElementNode(element) || isHiddenElement(element)) {
      return false;
    }

    const tagName = getTagName(element);
    if (tagName === "A" && element.hasAttribute?.("href")) {
      return true;
    }

    if (tagName === "IMG") {
      return true;
    }

    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tagName)) {
      return true;
    }

    if (String(element.getAttribute?.("contenteditable") || "").toLowerCase() === "true") {
      return true;
    }

    const role = String(element.getAttribute?.("role") || "").trim().toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) {
      return true;
    }

    if (STRUCTURAL_ROLES.has(role)) {
      return false;
    }

    if (hasInteractiveEventHandlerAttribute(element)) {
      return true;
    }

    return hasInteractiveEventHandlerProperty(element) && Boolean(normalizeText(element.textContent || ""));
  }

  function parseCssColor(value) {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue || normalizedValue === "transparent") {
      return null;
    }

    const rgbMatch = normalizedValue.match(/^rgba?\(([^)]+)\)$/iu);
    if (rgbMatch) {
      const parts = rgbMatch[1]
        .split(",")
        .map((part) => Number.parseFloat(String(part || "").trim()))
        .filter((part) => Number.isFinite(part));
      if (parts.length >= 3) {
        return {
          r: Math.max(0, Math.min(255, parts[0])),
          g: Math.max(0, Math.min(255, parts[1])),
          b: Math.max(0, Math.min(255, parts[2])),
          a: parts.length >= 4 ? Math.max(0, Math.min(1, parts[3])) : 1
        };
      }
    }

    const hexMatch = normalizedValue.match(/^#([\da-f]{3,8})$/iu);
    if (!hexMatch) {
      return null;
    }

    const hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return {
        r: Number.parseInt(`${r}${r}`, 16),
        g: Number.parseInt(`${g}${g}`, 16),
        b: Number.parseInt(`${b}${b}`, 16),
        a: Number.parseInt(`${a}${a}`, 16) / 255
      };
    }

    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
      };
    }

    return null;
  }

  function rgbToHsl(color) {
    if (!color) {
      return null;
    }

    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;

    if (delta > 0) {
      saturation = delta / (1 - Math.abs(2 * lightness - 1));
      if (max === r) {
        hue = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        hue = 60 * (((b - r) / delta) + 2);
      } else {
        hue = 60 * (((r - g) / delta) + 4);
      }
    }

    if (hue < 0) {
      hue += 360;
    }

    return {
      hue,
      lightness,
      saturation
    };
  }

  function getComputedStyleSafe(element) {
    try {
      return globalThis.getComputedStyle?.(element) || null;
    } catch {
      return null;
    }
  }

  function getElementRectSafe(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      if (!rect) {
        return null;
      }

      return {
        height: Number(rect.height) || 0,
        width: Number(rect.width) || 0
      };
    } catch {
      return null;
    }
  }

  function detectSemanticTone(element, computedStyle, metadata = {}) {
    const opacity = Number(computedStyle?.opacity || 1);
    const backgroundColor = parseCssColor(computedStyle?.backgroundColor || "");
    const borderColor = parseCssColor(computedStyle?.borderTopColor || "");
    const foregroundColor = parseCssColor(computedStyle?.color || "");
    const isButtonLike = ["BUTTON", "INPUT", "SUMMARY"].includes(getTagName(element))
      || ["button", "tab", "menuitem"].includes(String(element?.getAttribute?.("role") || "").trim().toLowerCase());

    if (metadata.disabled || metadata.blocked || opacity <= 0.58) {
      return "muted";
    }

    const preferredColor = [backgroundColor, borderColor, foregroundColor]
      .filter((color) => color && color.a > 0.15)
      .map((color) => ({
        color,
        hsl: rgbToHsl(color)
      }))
      .find((entry) => entry.hsl && entry.hsl.saturation >= 0.2);

    if (!preferredColor) {
      return "";
    }

    const {
      hue,
      lightness,
      saturation
    } = preferredColor.hsl;
    if (saturation < 0.2) {
      return "";
    }

    if ((hue >= 345 || hue < 20) && lightness >= 0.18 && lightness <= 0.82) {
      return "error";
    }

    if (hue >= 20 && hue < 65 && lightness >= 0.2 && lightness <= 0.9) {
      return "warning";
    }

    if (hue >= 65 && hue < 170 && lightness >= 0.16 && lightness <= 0.84) {
      return "success";
    }

    if (hue >= 170 && hue < 280 && lightness >= 0.14 && lightness <= 0.82) {
      if (isButtonLike && backgroundColor?.a > 0.2) {
        return "primary";
      }
      return "";
    }

    return "";
  }

  function collectElementStateMetadata(element) {
    if (!isElementNode(element)) {
      return {
        descriptorTags: [],
        semanticTags: [],
        stateTags: []
      };
    }

    const computedStyle = getComputedStyleSafe(element);
    const rect = getElementRectSafe(element);
    const tagName = getTagName(element);
    const ariaDisabled = String(element.getAttribute?.("aria-disabled") || "").trim().toLowerCase() === "true";
    const ariaBusy = String(element.getAttribute?.("aria-busy") || "").trim().toLowerCase() === "true";
    const ariaChecked = String(element.getAttribute?.("aria-checked") || "").trim().toLowerCase() === "true";
    const ariaCurrent = normalizeText(element.getAttribute?.("aria-current"));
    const ariaInvalid = String(element.getAttribute?.("aria-invalid") || "").trim().toLowerCase() === "true";
    const ariaPressed = String(element.getAttribute?.("aria-pressed") || "").trim().toLowerCase() === "true";
    const ariaReadonly = String(element.getAttribute?.("aria-readonly") || "").trim().toLowerCase() === "true";
    const ariaRequired = String(element.getAttribute?.("aria-required") || "").trim().toLowerCase() === "true";
    const ariaSelected = String(element.getAttribute?.("aria-selected") || "").trim().toLowerCase() === "true";
    const closestInert = typeof element.closest === "function" ? element.closest("[inert]") : null;
    const pointerEventsNone = normalizeText(computedStyle?.pointerEvents || "").toLowerCase() === "none";
    const disabled = Boolean(element.disabled || ariaDisabled || closestInert);
    const blocked = !disabled && pointerEventsNone;
    const checked = Boolean(element.checked || ariaChecked);
    const selected = tagName === "OPTION"
      ? Boolean(element.selected)
      : Boolean(ariaSelected);
    const invalid = Boolean(ariaInvalid || element.matches?.(":invalid"));
    const readonly = Boolean(element.readOnly || ariaReadonly);
    const required = Boolean(element.required || ariaRequired);
    const expanded = String(element.getAttribute?.("aria-expanded") || "").trim().toLowerCase() === "true";
    const pressed = ariaPressed;
    const busy = ariaBusy;
    const current = Boolean(ariaCurrent && ariaCurrent !== "false");
    const zeroRect = Boolean(
      rect
      && element.ownerDocument === globalThis.document
      && rect.width <= 1
      && rect.height <= 1
    );
    const opacity = Number(computedStyle?.opacity || 1);
    const semanticTone = detectSemanticTone(element, computedStyle, {
      blocked,
      disabled
    });
    const stateTags = [
      disabled ? "disabled" : "",
      !disabled && (blocked || zeroRect) ? "blocked" : "",
      checked ? "checked" : "",
      selected && tagName !== "SELECT" ? "selected" : "",
      invalid ? "invalid" : "",
      expanded ? "expanded" : "",
      pressed ? "pressed" : ""
    ].filter(Boolean);
    const semanticTags = semanticTone ? [semanticTone] : [];
    return {
      blocked,
      busy,
      checked,
      current,
      descriptorTags: [...stateTags, ...semanticTags],
      disabled,
      expanded,
      invalid,
      opacity,
      pointerEventsNone,
      pressed,
      readonly,
      required,
      selected,
      semanticTags,
      semanticTone,
      stateTags,
      visible: !isHiddenElement(element),
      zeroRect
    };
  }

  function getReferenceValueMetadata(element) {
    const tagName = getTagName(element);
    if (tagName === "INPUT") {
      const inputType = String(element.getAttribute?.("type") || element.type || "text").toLowerCase();
      if (inputType === "password") {
        return "";
      }
      return truncateText(element.value || element.getAttribute?.("value") || "", 96);
    }

    if (tagName === "TEXTAREA") {
      return truncateText(element.value || "", 96);
    }

    if (tagName === "SELECT") {
      return [...(element.selectedOptions || [])]
        .map((option) => truncateText(option.textContent || option.label || option.value || "", 48))
        .filter(Boolean)
        .join(" | ");
    }

    if (String(element.getAttribute?.("contenteditable") || "").toLowerCase() === "true") {
      return truncateText(element.textContent || "", 96);
    }

    return "";
  }

  function isFrameLikeElement(element) {
    return ["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(getTagName(element));
  }

  function createRequestId() {
    return `space-browser-dom-${Date.now()}-${nextRequestId++}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeFrameChain(frameChain) {
    const rawFrameChain = Array.isArray(frameChain)
      ? frameChain
      : typeof frameChain === "string"
        ? frameChain.split(">")
        : [];

    return rawFrameChain
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  function encodeFrameChain(frameChain) {
    return normalizeFrameChain(frameChain).join(">");
  }

  function ensureNodeId(element) {
    if (nodeIdsByElement.has(element)) {
      return nodeIdsByElement.get(element);
    }

    const nodeId = String(nextNodeId++);
    nodeIdsByElement.set(element, nodeId);
    elementsByNodeId.set(nodeId, element);
    return nodeId;
  }

  function serializeDoctype(doc) {
    const doctype = doc?.doctype;
    if (!doctype?.name) {
      return "";
    }

    if (doctype.publicId) {
      const systemId = doctype.systemId ? ` "${escapeHtmlAttribute(doctype.systemId)}"` : "";
      return `<!DOCTYPE ${doctype.name} PUBLIC "${escapeHtmlAttribute(doctype.publicId)}"${systemId}>`;
    }

    if (doctype.systemId) {
      return `<!DOCTYPE ${doctype.name} SYSTEM "${escapeHtmlAttribute(doctype.systemId)}">`;
    }

    return `<!DOCTYPE ${doctype.name}>`;
  }

  function serializeAttributes(element, frameChain) {
    const serializedAttributes = [];
    const helperManagedAttributes = new Set([
      "data-space-browser-node-id",
      "data-space-browser-frame-id",
      "data-space-browser-frame-chain",
      "data-space-browser-state-tags",
      "data-space-browser-semantic-tags",
      "data-space-browser-descriptor-tags",
      "data-space-browser-live-value",
      "data-space-browser-selected-text"
    ]);

    try {
      [...(element?.attributes || [])].forEach((attribute) => {
        const name = String(attribute?.name || "").trim();
        if (!name || helperManagedAttributes.has(name)) {
          return;
        }

        serializedAttributes.push(` ${name}="${escapeHtmlAttribute(attribute?.value || "")}"`);
      });
    } catch {
      // Ignore attribute read failures.
    }

    if (isActionableElement(element)) {
      const stateMetadata = collectElementStateMetadata(element);
      const liveValue = getReferenceValueMetadata(element);
      serializedAttributes.push(` data-space-browser-node-id="${escapeHtmlAttribute(ensureNodeId(element))}"`);
      serializedAttributes.push(` data-space-browser-frame-id="${escapeHtmlAttribute(helperFrameId)}"`);
      serializedAttributes.push(` data-space-browser-frame-chain="${escapeHtmlAttribute(encodeFrameChain(frameChain))}"`);
      if (stateMetadata.stateTags.length) {
        serializedAttributes.push(` data-space-browser-state-tags="${escapeHtmlAttribute(stateMetadata.stateTags.join(" "))}"`);
      }
      if (stateMetadata.semanticTags.length) {
        serializedAttributes.push(` data-space-browser-semantic-tags="${escapeHtmlAttribute(stateMetadata.semanticTags.join(" "))}"`);
      }
      if (stateMetadata.descriptorTags.length) {
        serializedAttributes.push(` data-space-browser-descriptor-tags="${escapeHtmlAttribute(stateMetadata.descriptorTags.join(" "))}"`);
      }
      if (liveValue) {
        serializedAttributes.push(` data-space-browser-live-value="${escapeHtmlAttribute(liveValue)}"`);
        if (getTagName(element) === "SELECT") {
          serializedAttributes.push(` data-space-browser-selected-text="${escapeHtmlAttribute(liveValue)}"`);
        }
      }
    }

    return serializedAttributes.join("");
  }

  function normalizeSnapshotMode(value) {
    return String(value || "").trim().toLowerCase() || "dom";
  }

  function normalizeSelectorList(payload = {}) {
    const rawSelectors = typeof payload === "string"
      ? [payload]
      : Array.isArray(payload?.selectors)
        ? payload.selectors
        : typeof payload?.selectors === "string"
          ? [payload.selectors]
          : Array.isArray(payload?.selector)
            ? payload.selector
            : typeof payload?.selector === "string"
              ? [payload.selector]
              : [];

    return rawSelectors
      .map((selector) => String(selector || "").trim())
      .filter(Boolean);
  }

  function isContentSnapshotMode(payload = {}) {
    return normalizeSnapshotMode(payload?.snapshotMode) === "content";
  }

  async function serializeChildNodes(parentNode, frameChain, payload = {}) {
    const parts = [];
    const childNodes = Array.from(parentNode?.childNodes || []);

    for (const childNode of childNodes) {
      parts.push(await serializeNode(childNode, frameChain, payload));
    }

    return parts.join("");
  }

  function resolveElementWindow(element) {
    try {
      if (element?.contentWindow) {
        return element.contentWindow;
      }
    } catch {
      return null;
    }

    return null;
  }

  async function requestChildFrameOperation(targetWindow, type, payload = {}, frameElement = null) {
    if (!targetWindow || typeof targetWindow.postMessage !== "function") {
      throw createNamedError(
        "BrowserDomHelperFrameUnavailableError",
        "Embedded frame window is unavailable.",
        {
          code: "browser_dom_helper_frame_window_unavailable",
          details: {
            frameElementTag: getTagName(frameElement).toLowerCase()
          }
        }
      );
    }

    return new Promise((resolve, reject) => {
      const requestId = createRequestId();
      const timer = globalThis.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(createNamedError(
          "BrowserDomHelperFrameTimeoutError",
          `Embedded frame request "${type}" timed out.`,
          {
            code: "browser_dom_helper_frame_timeout",
            details: {
              type
            }
          }
        ));
      }, requestTimeoutMs);

      pendingRequests.set(requestId, {
        reject,
        resolve,
        timer,
        type
      });

      try {
        targetWindow.postMessage({
          channel,
          payload,
          requestId,
          type
        }, "*");
      } catch (error) {
        globalThis.clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(createNamedError(
          "BrowserDomHelperFrameRequestError",
          `Embedded frame request "${type}" could not be posted.`,
          {
            cause: error,
            code: "browser_dom_helper_frame_postmessage_failed",
            details: {
              type
            }
          }
        ));
      }
    });
  }

  function registerChildFrame(frameId, targetWindow) {
    const normalizedFrameId = String(frameId || "").trim();
    if (!normalizedFrameId || !targetWindow || typeof targetWindow.postMessage !== "function") {
      return;
    }

    childFramesById.set(normalizedFrameId, targetWindow);
  }

  function extractDocumentBodyHtml(html) {
    let normalizedHtml = String(html || "").trim();
    if (!normalizedHtml) {
      return "";
    }

    const unwrapHelperWrappers = (value) => {
      let currentValue = String(value || "").trim();
      for (let index = 0; index < 4; index += 1) {
        const wrapperMatch = currentValue.match(
          /^<space-browser-(?:frame-document|shadow-root)\b[^>]*>([\s\S]*?)<\/space-browser-(?:frame-document|shadow-root)>$/iu
        );
        if (!wrapperMatch) {
          break;
        }

        currentValue = String(wrapperMatch[1] || "").trim();
      }

      return currentValue;
    };

    normalizedHtml = unwrapHelperWrappers(
      normalizedHtml.replace(/<!doctype[\s\S]*?>/iu, "").trim()
    );

    const bodyMatch = normalizedHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu);
    if (bodyMatch) {
      return unwrapHelperWrappers(String(bodyMatch[1] || "").trim());
    }

    try {
      if (typeof DOMParser === "function") {
        const parsedDocument = new DOMParser().parseFromString(normalizedHtml, "text/html");
        const parsedBodyHtml = String(parsedDocument.body?.innerHTML || "").trim();
        if (parsedBodyHtml) {
          return unwrapHelperWrappers(parsedBodyHtml);
        }
      }
    } catch {
      // Ignore fallback parse failures and return the normalized source below.
    }

    return normalizedHtml;
  }

  async function captureFrameElement(frameElement, frameChain, payload = {}) {
    const childWindow = resolveElementWindow(frameElement);
    if (!childWindow) {
      return {
        frameChain: [],
        frameId: "",
        html: escapeHtmlText("Embedded frame snapshot unavailable."),
        message: "Embedded frame snapshot unavailable.",
        ok: false,
        status: "window_unavailable",
        title: "",
        url: String(frameElement?.getAttribute?.("src") || "").trim()
      };
    }

    const childPayload = {
      snapshotMode: normalizeSnapshotMode(payload?.snapshotMode),
      parentFrameChain: frameChain
    };

    try {
      const helper = childWindow[helperKey];
      if (helper && typeof helper.captureDocument === "function") {
        const snapshot = await helper.captureDocument(childPayload);
        registerChildFrame(snapshot?.frameId, childWindow);
        return snapshot;
      }
    } catch {
      // Fall through to same-origin document access or postMessage.
    }

    try {
      const frameDocument = frameElement?.contentDocument;
      if (frameDocument) {
        const currentFrameChain = normalizeFrameChain(frameChain).concat(helperFrameId);
        const childSnapshot = {
          frameChain: currentFrameChain,
          frameId: helperFrameId,
          html: await serializeDocumentNode(frameDocument, currentFrameChain, childPayload),
          ok: true,
          title: String(frameDocument.title || "").trim(),
          url: String(childWindow.location?.href || frameElement?.src || "").trim()
        };
        registerChildFrame(childSnapshot.frameId, childWindow);
        return childSnapshot;
      }
    } catch {
      // Cross-origin frame fallback below.
    }

    const snapshot = await requestChildFrameOperation(childWindow, "capture_document", childPayload, frameElement);
    registerChildFrame(snapshot?.frameId, childWindow);
    return snapshot;
  }

  function renderFrameDocument(snapshot, frameElement, payload = {}) {
    const normalizedSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const frameChain = encodeFrameChain(normalizedSnapshot.frameChain);
    const frameId = String(normalizedSnapshot.frameId || "").trim();
    const status = normalizedSnapshot.ok === false
      ? String(normalizedSnapshot.status || "error").trim() || "error"
      : "ok";
    const message = String(normalizedSnapshot.message || "").trim();
    const src = String(frameElement?.getAttribute?.("src") || frameElement?.src || "").trim();
    const title = String(normalizedSnapshot.title || frameElement?.getAttribute?.("title") || "").trim();
    const url = String(normalizedSnapshot.url || src).trim();
    const content = String(
      normalizedSnapshot.html
      || escapeHtmlText(message || "Embedded frame snapshot unavailable.")
    );

    if (isContentSnapshotMode(payload)) {
      if (normalizedSnapshot.ok === false) {
        return "";
      }

      return extractDocumentBodyHtml(content);
    }

    return `<space-browser-frame-document`
      + ` data-space-browser-frame-id="${escapeHtmlAttribute(frameId)}"`
      + ` data-space-browser-frame-chain="${escapeHtmlAttribute(frameChain)}"`
      + ` data-space-browser-status="${escapeHtmlAttribute(status)}"`
      + ` data-space-browser-frame-url="${escapeHtmlAttribute(url)}"`
      + ` data-space-browser-frame-title="${escapeHtmlAttribute(title)}"`
      + ` data-space-browser-frame-src="${escapeHtmlAttribute(src)}">`
      + content
      + `</space-browser-frame-document>`;
  }

  function createFrameCaptureFailureSnapshot(frameElement, frameChain, error) {
    const normalizedFrameChain = normalizeFrameChain(frameChain);
    const frameUrl = String(frameElement?.getAttribute?.("src") || frameElement?.src || "").trim();
    const frameTitle = String(frameElement?.getAttribute?.("title") || "").trim();
    const errorCode = String(error?.code || "").trim() || "capture_failed";
    const errorMessage = String(error?.message || "Embedded frame snapshot unavailable.").trim()
      || "Embedded frame snapshot unavailable.";

    return {
      frameChain: normalizedFrameChain,
      frameId: "",
      html: escapeHtmlText(errorMessage),
      message: errorMessage,
      ok: false,
      status: errorCode,
      title: frameTitle,
      url: frameUrl
    };
  }

  async function serializeElementNode(element, frameChain, payload = {}) {
    const tagName = String(element?.tagName || "").toLowerCase();
    if (!tagName) {
      return "";
    }

    if (isContentSnapshotMode(payload) && isHiddenElement(element)) {
      return "";
    }

    const openTag = `<${tagName}${serializeAttributes(element, frameChain)}>`;
    const lightDom = await serializeChildNodes(element, frameChain, payload);
    let shadowDom = "";

    try {
      const shadowRoot = element?.shadowRoot;
      if (shadowRoot) {
        const shadowInnerHtml = await serializeChildNodes(shadowRoot, frameChain, payload);
        if (isContentSnapshotMode(payload)) {
          shadowDom = shadowInnerHtml;
        } else {
          const shadowMode = String(shadowRoot.mode || "open").trim() || "open";
          shadowDom = `<space-browser-shadow-root mode="${escapeHtmlAttribute(shadowMode)}">${shadowInnerHtml}</space-browser-shadow-root>`;
        }
      }
    } catch {
      shadowDom = "";
    }

    let frameDom = "";
    if (isFrameLikeElement(element)) {
      let frameSnapshot = null;
      try {
        frameSnapshot = await captureFrameElement(element, frameChain, payload);
      } catch (error) {
        frameSnapshot = createFrameCaptureFailureSnapshot(element, frameChain, error);
      }
      frameDom = renderFrameDocument(frameSnapshot, element, payload);
    }

    if (VOID_TAGS.has(tagName)) {
      return `${openTag}${shadowDom}${frameDom}`;
    }

    return `${openTag}${lightDom}${shadowDom}${frameDom}</${tagName}>`;
  }

  async function serializeNode(node, frameChain, payload = {}) {
    if (!node || typeof node.nodeType !== "number") {
      return "";
    }

    if (node.nodeType === 9) {
      return serializeDocumentNode(node, frameChain, payload);
    }

    if (node.nodeType === 11) {
      return serializeChildNodes(node, frameChain, payload);
    }

    if (node.nodeType === 1) {
      return serializeElementNode(node, frameChain, payload);
    }

    if (node.nodeType === 3) {
      return escapeHtmlText(node.textContent || "");
    }

    if (node.nodeType === 8) {
      return `<!--${escapeHtmlText(node.data || "")}-->`;
    }

    return "";
  }

  async function serializeDocumentNode(doc, frameChain, payload = {}) {
    const doctype = serializeDoctype(doc);
    const documentHtml = await serializeChildNodes(doc, frameChain, payload);
    return `${doctype}${documentHtml}`;
  }

  async function serializeSelectorTargets(doc, selectors, frameChain, payload = {}) {
    const targets = {};

    for (const selector of selectors) {
      let elements = [];

      try {
        elements = [...(doc?.querySelectorAll?.(selector) || [])];
      } catch (error) {
        throw createNamedError(
          "BrowserDomHelperSelectorError",
          `Browser DOM helper could not resolve selector "${selector}".`,
          {
            cause: error,
            code: "browser_dom_helper_selector_error",
            details: {
              selector
            }
          }
        );
      }

      const parts = [];
      for (const element of elements) {
        parts.push(await serializeNode(element, frameChain, payload));
      }

      targets[selector] = parts.join("");
    }

    return targets;
  }

  async function captureDocument(payload = {}) {
    childFramesById.clear();
    const currentFrameChain = normalizeFrameChain(payload?.parentFrameChain).concat(helperFrameId);
    const selectors = normalizeSelectorList(payload);
    const documentSnapshot = {
      frameChain: currentFrameChain,
      frameId: helperFrameId,
      ok: true,
      title: String(globalThis.document?.title || "").trim(),
      url: String(globalThis.location?.href || "").trim()
    };

    if (selectors.length) {
      return {
        ...documentSnapshot,
        targets: await serializeSelectorTargets(globalThis.document, selectors, currentFrameChain, payload)
      };
    }

    return {
      ...documentSnapshot,
      html: await serializeDocumentNode(globalThis.document, currentFrameChain, payload),
    };
  }

  function getElementByNodeId(nodeId, actionLabel) {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      throw createNamedError(
        "BrowserDomHelperReferenceError",
        `Browser DOM helper ${actionLabel} requires a node id.`,
        {
          code: "browser_dom_helper_node_required",
          details: {
            action: actionLabel
          }
        }
      );
    }

    const element = elementsByNodeId.get(normalizedNodeId);
    if (!element) {
      throw createNamedError(
        "BrowserDomHelperReferenceError",
        `Browser DOM helper could not find node "${normalizedNodeId}".`,
        {
          code: "browser_dom_helper_node_not_found",
          details: {
            action: actionLabel,
            nodeId: normalizedNodeId
          }
        }
      );
    }

    if (element.isConnected === false) {
      throw createNamedError(
        "BrowserDomHelperReferenceError",
        `Browser DOM helper node "${normalizedNodeId}" is no longer connected.`,
        {
          code: "browser_dom_helper_node_disconnected",
          details: {
            action: actionLabel,
            nodeId: normalizedNodeId
          }
        }
      );
    }

    return element;
  }

  function serializeElementSnapshot(element) {
    if (!isElementNode(element)) {
      return "";
    }

    try {
      if (typeof element.outerHTML === "string" && element.outerHTML) {
        return element.outerHTML;
      }
    } catch {
      // Fall through to XMLSerializer.
    }

    try {
      if (typeof globalThis.XMLSerializer === "function") {
        return new globalThis.XMLSerializer().serializeToString(element);
      }
    } catch {
      // Ignore serialization errors.
    }

    return "";
  }

  function scrollElementIntoView(element) {
    try {
      element.scrollIntoView?.({
        behavior: "auto",
        block: "center",
        inline: "center"
      });
      return true;
    } catch {
      return false;
    }
  }

  function focusElement(element) {
    try {
      element.focus?.({
        preventScroll: true
      });
      return true;
    } catch {
      try {
        element.focus?.();
        return true;
      } catch {
        return false;
      }
    }
  }

  function dispatchDomEvent(target, eventName, EventType = "Event", options = {}) {
    const EventConstructor = typeof globalThis[EventType] === "function"
      ? globalThis[EventType]
      : globalThis.Event;
    const event = new EventConstructor(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...options
    });
    target.dispatchEvent(event);
    return event;
  }

  function dispatchKeyboardEvent(target, eventName, options = {}) {
    const KeyboardEventConstructor = typeof globalThis.KeyboardEvent === "function"
      ? globalThis.KeyboardEvent
      : globalThis.Event;
    const event = new KeyboardEventConstructor(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      code: "Enter",
      key: "Enter",
      ...options
    });

    [
      ["charCode", Number(options.charCode ?? 0)],
      ["keyCode", Number(options.keyCode ?? 13)],
      ["which", Number(options.which ?? 13)]
    ].forEach(([propertyName, propertyValue]) => {
      try {
        if (typeof event[propertyName] !== "number") {
          Object.defineProperty(event, propertyName, {
            configurable: true,
            enumerable: true,
            value: propertyValue
          });
        }
      } catch {
        // Ignore read-only KeyboardEvent properties.
      }
    });

    target.dispatchEvent(event);
    return event;
  }

  function setNativeValue(element, nextValue) {
    const tagName = getTagName(element);
    const normalizedValue = String(nextValue ?? "");

    if (tagName === "INPUT") {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(element, normalizedValue);
      } else {
        element.value = normalizedValue;
      }
      return normalizedValue;
    }

    if (tagName === "TEXTAREA") {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(element, normalizedValue);
      } else {
        element.value = normalizedValue;
      }
      return normalizedValue;
    }

    if (tagName === "SELECT") {
      const matchedOption = [...(element.options || [])].find((option) => {
        return option.value === normalizedValue
          || normalizeText(option.textContent || "") === normalizeText(normalizedValue)
          || normalizeText(option.label || "") === normalizeText(normalizedValue);
      });

      const resolvedValue = matchedOption ? matchedOption.value : normalizedValue;
      const descriptor = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(element, resolvedValue);
      } else {
        element.value = resolvedValue;
      }
      return resolvedValue;
    }

    if (String(element.getAttribute?.("contenteditable") || "").toLowerCase() === "true") {
      element.textContent = normalizedValue;
      return normalizedValue;
    }

    throw createNamedError(
      "BrowserDomHelperActionError",
      `Browser DOM helper cannot type into <${getTagName(element).toLowerCase()}>.`,
      {
        code: "browser_dom_helper_type_unsupported"
      }
    );
  }

  function shouldEnterSubmitForm(element) {
    const tagName = getTagName(element);
    if (tagName !== "INPUT") {
      return false;
    }

    const inputType = String(element.getAttribute?.("type") || element.type || "text").toLowerCase();
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit"
    ].includes(inputType);
  }

  function delayMs(timeoutMs) {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
    });
  }

  function describeActiveElement(element) {
    if (!isElementNode(element)) {
      return "";
    }

    const tagName = getTagName(element).toLowerCase();
    const id = normalizeAttributeText(element.getAttribute?.("id"));
    const name = normalizeAttributeText(element.getAttribute?.("name"));
    return [tagName, id ? `#${id}` : "", name ? `name=${name}` : ""].filter(Boolean).join(" ");
  }

  function getActionObservationRoot(element) {
    if (!isElementNode(element)) {
      return globalThis.document?.body || globalThis.document?.documentElement || null;
    }

    return element.closest?.("form, fieldset, dialog, [role='dialog'], [role='alert'], [role='status'], [aria-live], article, section, main, li, tr, td, th")
      || element.parentElement
      || element;
  }

  function getElementDirectText(element) {
    if (!isElementNode(element)) {
      return "";
    }

    return normalizeText(
      [...(element.childNodes || [])]
        .filter((node) => isTextNode(node))
        .map((node) => node.textContent || "")
        .join(" ")
    );
  }

  function collectNearbyTextEntries(root, limit = 24) {
    if (!isElementNode(root)) {
      return [];
    }

    const entries = [];
    const seen = new Set();
    const acceptElement = (element) => {
      if (!isElementNode(element) || isHiddenElement(element) || entries.length >= limit) {
        return;
      }

      const role = normalizeText(element.getAttribute?.("role")).toLowerCase();
      const directText = getElementDirectText(element);
      const fallbackText = ["alert", "status"].includes(role) || element.hasAttribute?.("aria-live")
        ? normalizeText(element.textContent || "")
        : "";
      const text = truncateText(directText || fallbackText, 220);
      if (!text) {
        return;
      }

      const key = `${role}|${text}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const state = collectElementStateMetadata(element);
      entries.push({
        invalid: state.invalid === true,
        role,
        semanticTone: state.semanticTone || "",
        text
      });
    };

    acceptElement(root);
    const walker = globalThis.document?.createTreeWalker?.(root, globalThis.NodeFilter?.SHOW_ELEMENT ?? 1);
    if (!walker) {
      return entries;
    }

    let currentNode = walker.nextNode();
    while (currentNode && entries.length < limit) {
      acceptElement(currentNode);
      currentNode = walker.nextNode();
    }

    return entries;
  }

  function captureActionEffectSnapshot(element) {
    const observationRoot = getActionObservationRoot(element);
    return {
      activeElement: describeActiveElement(globalThis.document?.activeElement),
      observationRoot,
      observationText: truncateText(normalizeText(observationRoot?.textContent || ""), 2000),
      targetDom: truncateText(serializeElementSnapshot(element), 2000),
      targetState: collectElementStateMetadata(element),
      textEntries: collectNearbyTextEntries(observationRoot),
      value: getReferenceValueMetadata(element)
    };
  }

  async function withObservedActionWindow(observationRoot, action, {
    quietMs = 40,
    timeoutMs = 180
  } = {}) {
    const target = observationRoot?.ownerDocument?.body
      || observationRoot?.ownerDocument?.documentElement
      || globalThis.document?.body
      || globalThis.document?.documentElement;
    if (!target || typeof globalThis.MutationObserver !== "function") {
      const result = await action();
      await delayMs(timeoutMs);
      return {
        observedMutations: {
          attributeNames: [],
          mutationCount: 0
        },
        result
      };
    }

    const attributeNames = new Set();
    let lastMutationAt = 0;
    let mutationCount = 0;
    const observer = new globalThis.MutationObserver((mutations) => {
      mutationCount += mutations.length;
      lastMutationAt = Date.now();
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName) {
          attributeNames.add(String(mutation.attributeName));
        }
      });
    });

    try {
      observer.observe(target, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
      const result = await action();
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await delayMs(20);
        if (mutationCount > 0 && Date.now() - lastMutationAt >= quietMs) {
          break;
        }
      }
      return {
        observedMutations: {
          attributeNames: [...attributeNames],
          mutationCount
        },
        result
      };
    } finally {
      observer.disconnect();
    }
  }

  function compareDescriptorTags(beforeTags = [], afterTags = []) {
    const beforeValue = beforeTags.filter(Boolean).join("|");
    const afterValue = afterTags.filter(Boolean).join("|");
    return beforeValue !== afterValue;
  }

  function buildActionEffectResult(beforeSnapshot, afterSnapshot, observedMutations, extra = {}) {
    const newTextEntries = afterSnapshot.textEntries.filter((entryData) => {
      return !beforeSnapshot.textEntries.some((beforeEntry) => beforeEntry.text === entryData.text);
    });
    const validationEntries = newTextEntries.filter((entryData) => {
      return entryData.invalid
        || ["alert", "status"].includes(entryData.role)
        || ["error", "warning"].includes(entryData.semanticTone);
    });
    const focusChanged = beforeSnapshot.activeElement !== afterSnapshot.activeElement;
    const nearbyTextChanged = beforeSnapshot.observationText !== afterSnapshot.observationText;
    const valueChanged = beforeSnapshot.value !== afterSnapshot.value;
    const checkedChanged = beforeSnapshot.targetState.checked !== afterSnapshot.targetState.checked;
    const selectedChanged = beforeSnapshot.targetState.selected !== afterSnapshot.targetState.selected;
    const expandedChanged = beforeSnapshot.targetState.expanded !== afterSnapshot.targetState.expanded;
    const pressedChanged = beforeSnapshot.targetState.pressed !== afterSnapshot.targetState.pressed;
    const descriptorChanged = compareDescriptorTags(beforeSnapshot.targetState.descriptorTags, afterSnapshot.targetState.descriptorTags);
    const targetDomChanged = beforeSnapshot.targetDom !== afterSnapshot.targetDom;
    const domChanged = Boolean(observedMutations.mutationCount) || targetDomChanged || nearbyTextChanged;
    const status = {
      alertTextAdded: newTextEntries.some((entryData) => ["alert", "status"].includes(entryData.role)),
      checkedChanged,
      descriptorChanged,
      domChanged,
      expandedChanged,
      focusChanged,
      nearbyTextChanged,
      pressedChanged,
      reacted: false,
      selectedChanged,
      targetChanged: descriptorChanged || targetDomChanged || valueChanged || checkedChanged || selectedChanged || expandedChanged || pressedChanged,
      targetDomChanged,
      valueChanged,
      validationTextAdded: validationEntries.length > 0
    };
    status.reacted = Object.entries(status).some(([key, value]) => key !== "reacted" && value === true);
    status.noObservedEffect = !status.reacted;

    return {
      ...extra,
      effect: {
        mutationAttributes: observedMutations.attributeNames.slice(0, 8),
        mutationCount: observedMutations.mutationCount,
        newText: newTextEntries.map((entryData) => entryData.text).slice(0, 3),
        semanticHints: [...new Set(newTextEntries.map((entryData) => entryData.semanticTone).filter(Boolean))].slice(0, 3),
        validationText: validationEntries.map((entryData) => entryData.text).slice(0, 3)
      },
      status
    };
  }

  function collectActionResult(element) {
    const state = collectElementStateMetadata(element);
    return {
      connected: element.isConnected !== false,
      descriptorTags: state.descriptorTags.slice(),
      dom: serializeElementSnapshot(element),
      frameId: helperFrameId,
      nodeId: ensureNodeId(element),
      semanticTags: state.semanticTags.slice(),
      state,
      tagName: getTagName(element)
    };
  }

  function detailLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "detail");
    return collectActionResult(element);
  }

  function clickLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "click");
    const beforeSnapshot = captureActionEffectSnapshot(element);
    scrollElementIntoView(element);
    focusElement(element);

    if (beforeSnapshot.targetState.disabled) {
      throw createNamedError(
        "BrowserDomHelperActionError",
        `Browser DOM helper node "${payload?.nodeId}" is disabled.`,
        {
          code: "browser_dom_helper_click_disabled"
        }
      );
    }

    return withObservedActionWindow(beforeSnapshot.observationRoot, async () => {
      if (typeof element.click === "function") {
        element.click();
      } else {
        dispatchDomEvent(element, "click", "MouseEvent", {
          button: 0
        });
      }
    }).then(({ observedMutations }) => ({
      ...collectActionResult(element),
      ...buildActionEffectResult(beforeSnapshot, captureActionEffectSnapshot(element), observedMutations)
    }));
  }

  function typeLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "type");
    const beforeSnapshot = captureActionEffectSnapshot(element);
    return withObservedActionWindow(beforeSnapshot.observationRoot, async () => {
      scrollElementIntoView(element);
      focusElement(element);
      const appliedValue = setNativeValue(element, payload?.value ?? "");

      if (typeof element.setSelectionRange === "function") {
        try {
          element.setSelectionRange(String(appliedValue).length, String(appliedValue).length);
        } catch {
          // Ignore selection errors for unsupported input types.
        }
      }

      dispatchDomEvent(element, "beforeinput", "InputEvent", {
        data: String(payload?.value ?? ""),
        inputType: "insertText"
      });
      dispatchDomEvent(element, "input", "InputEvent", {
        data: String(payload?.value ?? ""),
        inputType: "insertText"
      });
      dispatchDomEvent(element, "change");
      return appliedValue;
    }).then(({ observedMutations, result }) => ({
      ...collectActionResult(element),
      ...buildActionEffectResult(beforeSnapshot, captureActionEffectSnapshot(element), observedMutations),
      value: result
    }));
  }

  function submitLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "submit");
    const tagName = getTagName(element);
    const beforeSnapshot = captureActionEffectSnapshot(element);

    return withObservedActionWindow(beforeSnapshot.observationRoot, async () => {
      scrollElementIntoView(element);
      focusElement(element);

      if (tagName === "FORM") {
        if (typeof element.requestSubmit === "function") {
          element.requestSubmit();
        } else {
          const submitEvent = dispatchDomEvent(element, "submit");
          if (!submitEvent.defaultPrevented) {
            element.submit?.();
          }
        }
      } else if (typeof element.form?.requestSubmit === "function") {
        if (tagName === "BUTTON" || tagName === "INPUT") {
          element.form.requestSubmit(element);
        } else {
          element.form.requestSubmit();
        }
      } else if (element.form) {
        const submitEvent = dispatchDomEvent(element.form, "submit");
        if (!submitEvent.defaultPrevented) {
          element.form.submit?.();
        }
      } else if (typeof element.click === "function") {
        element.click();
      } else {
        throw createNamedError(
          "BrowserDomHelperActionError",
          `Browser DOM helper cannot submit node "${payload?.nodeId}".`,
          {
            code: "browser_dom_helper_submit_unsupported"
          }
        );
      }
    }).then(({ observedMutations }) => ({
      ...collectActionResult(element),
      ...buildActionEffectResult(beforeSnapshot, captureActionEffectSnapshot(element), observedMutations)
    }));
  }

  function pressEnterLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "type_submit");
    const beforeSnapshot = captureActionEffectSnapshot(element);
    return withObservedActionWindow(beforeSnapshot.observationRoot, async () => {
      scrollElementIntoView(element);
      focusElement(element);

      const keydownEvent = dispatchKeyboardEvent(element, "keydown", {
        charCode: 0,
        keyCode: 13,
        which: 13
      });
      const keypressEvent = dispatchKeyboardEvent(element, "keypress", {
        charCode: 13,
        keyCode: 13,
        which: 13
      });
      const keyupEvent = dispatchKeyboardEvent(element, "keyup", {
        charCode: 0,
        keyCode: 13,
        which: 13
      });

      if (
        !keydownEvent.defaultPrevented
        && !keypressEvent.defaultPrevented
        && !keyupEvent.defaultPrevented
        && shouldEnterSubmitForm(element)
      ) {
        if (typeof element.form?.requestSubmit === "function") {
          element.form.requestSubmit();
        } else if (element.form) {
          const submitEvent = dispatchDomEvent(element.form, "submit");
          if (!submitEvent.defaultPrevented) {
            element.form.submit?.();
          }
        }
      }
    }).then(({ observedMutations }) => ({
      ...collectActionResult(element),
      ...buildActionEffectResult(beforeSnapshot, captureActionEffectSnapshot(element), observedMutations)
    }));
  }

  async function typeSubmitLocalNode(payload = {}) {
    const typed = await typeLocalNode(payload);
    const submitted = await pressEnterLocalNode(payload);
    const mergedStatus = {};
    [typed?.status || {}, submitted?.status || {}].forEach((statusBlock) => {
      Object.entries(statusBlock).forEach(([key, value]) => {
        if (typeof value === "boolean") {
          mergedStatus[key] = mergedStatus[key] === true || value === true;
        }
      });
    });
    mergedStatus.reacted = Object.entries(mergedStatus).some(([key, value]) => key !== "reacted" && key !== "noObservedEffect" && value === true);
    mergedStatus.noObservedEffect = !mergedStatus.reacted;
    return {
      ...submitted,
      effect: {
        mutationAttributes: [...new Set([...(typed?.effect?.mutationAttributes || []), ...(submitted?.effect?.mutationAttributes || [])])],
        mutationCount: Number(typed?.effect?.mutationCount || 0) + Number(submitted?.effect?.mutationCount || 0),
        newText: [...new Set([...(typed?.effect?.newText || []), ...(submitted?.effect?.newText || [])])].slice(0, 3),
        semanticHints: [...new Set([...(typed?.effect?.semanticHints || []), ...(submitted?.effect?.semanticHints || [])])].slice(0, 3),
        validationText: [...new Set([...(typed?.effect?.validationText || []), ...(submitted?.effect?.validationText || [])])].slice(0, 3)
      },
      status: mergedStatus,
      value: typed.value
    };
  }

  function scrollLocalNode(payload = {}) {
    const element = getElementByNodeId(payload?.nodeId, "scroll");
    const beforeSnapshot = captureActionEffectSnapshot(element);
    scrollElementIntoView(element);
    focusElement(element);
    const afterSnapshot = captureActionEffectSnapshot(element);
    const scrollEffect = buildActionEffectResult(beforeSnapshot, afterSnapshot, {
      attributeNames: [],
      mutationCount: 0
    });
    return {
      ...collectActionResult(element),
      ...scrollEffect,
      status: {
        ...scrollEffect.status,
        reacted: true,
        noObservedEffect: false
      }
    };
  }

  async function invokeLocalOperation(type, payload = {}) {
    if (type === "capture_document") {
      return captureDocument(payload);
    }

    if (type === "detail_node") {
      return detailLocalNode(payload);
    }

    if (type === "click_node") {
      return clickLocalNode(payload);
    }

    if (type === "type_node") {
      return typeLocalNode(payload);
    }

    if (type === "submit_node") {
      return submitLocalNode(payload);
    }

    if (type === "type_submit_node") {
      return typeSubmitLocalNode(payload);
    }

    if (type === "scroll_node") {
      return scrollLocalNode(payload);
    }

    throw createNamedError(
      "BrowserDomHelperActionError",
      `Browser DOM helper does not support "${type}".`,
      {
        code: "browser_dom_helper_action_unsupported",
        details: {
          type
        }
      }
    );
  }

  async function routeOperation(type, payload = {}) {
    const frameChain = normalizeFrameChain(payload?.frameChain);
    if (!frameChain.length) {
      return invokeLocalOperation(type, payload);
    }

    if (frameChain[0] !== helperFrameId) {
      throw createNamedError(
        "BrowserDomHelperFrameRouteError",
        `Browser DOM helper cannot route frame chain "${encodeFrameChain(frameChain)}" from "${helperFrameId}".`,
        {
          code: "browser_dom_helper_frame_chain_mismatch",
          details: {
            frameChain
          }
        }
      );
    }

    if (frameChain.length === 1) {
      return invokeLocalOperation(type, payload);
    }

    const nextFrameId = frameChain[1];
    const childWindow = childFramesById.get(nextFrameId);
    if (!childWindow) {
      throw createNamedError(
        "BrowserDomHelperFrameRouteError",
        `Browser DOM helper does not know child frame "${nextFrameId}".`,
        {
          code: "browser_dom_helper_child_frame_missing",
          details: {
            frameChain
          }
        }
      );
    }

    return requestChildFrameOperation(childWindow, type, {
      ...payload,
      frameChain: frameChain.slice(1)
    });
  }

  globalThis.addEventListener("message", (event) => {
    const rawMessage = event?.data;
    if (!rawMessage || rawMessage.channel !== channel || typeof rawMessage.type !== "string") {
      return;
    }

    const requestId = typeof rawMessage.requestId === "string" ? rawMessage.requestId : "";
    if (!requestId) {
      return;
    }

    if (rawMessage.type.endsWith("_result")) {
      const pendingRequest = pendingRequests.get(requestId);
      if (!pendingRequest) {
        return;
      }

      pendingRequests.delete(requestId);
      if (pendingRequest.timer != null) {
        globalThis.clearTimeout(pendingRequest.timer);
      }

      if (rawMessage.ok === false) {
        pendingRequest.reject(createNamedError(
          "BrowserDomHelperRemoteError",
          String(rawMessage?.payload?.message || `Embedded frame request "${pendingRequest.type}" failed.`),
          {
            code: rawMessage?.payload?.code ?? "browser_dom_helper_remote_error",
            details: rawMessage?.payload?.details || {},
            payload: rawMessage.payload
          }
        ));
        return;
      }

      pendingRequest.resolve(rawMessage.payload);
      return;
    }

    if (typeof event?.source?.postMessage !== "function") {
      return;
    }

    Promise.resolve(routeOperation(rawMessage.type, rawMessage.payload || {}))
      .then((payload) => {
        event.source.postMessage({
          channel,
          ok: true,
          payload,
          requestId,
          type: `${rawMessage.type}_result`
        }, "*");
      })
      .catch((error) => {
        console.error(`[space-browser/dom-helper] Request "${rawMessage.type}" failed.`, error);
        event.source.postMessage({
          channel,
          ok: false,
          payload: {
            code: error?.code ?? "browser_dom_helper_error",
            details: error?.details || {},
            message: String(error?.message || `Embedded frame request "${rawMessage.type}" failed.`)
          },
          requestId,
          type: `${rawMessage.type}_result`
        }, "*");
      });
  });

  globalThis[helperKey] = {
    captureDocument(payload) {
      return captureDocument(payload);
    },
    clickNode(frameChain, nodeId) {
      return routeOperation("click_node", {
        frameChain,
        nodeId
      });
    },
    detailNode(frameChain, nodeId) {
      return routeOperation("detail_node", {
        frameChain,
        nodeId
      });
    },
    frameId: helperFrameId,
    scrollNode(frameChain, nodeId) {
      return routeOperation("scroll_node", {
        frameChain,
        nodeId
      });
    },
    submitNode(frameChain, nodeId) {
      return routeOperation("submit_node", {
        frameChain,
        nodeId
      });
    },
    typeNode(frameChain, nodeId, value) {
      return routeOperation("type_node", {
        frameChain,
        nodeId,
        value
      });
    },
    typeSubmitNode(frameChain, nodeId, value) {
      return routeOperation("type_submit_node", {
        frameChain,
        nodeId,
        value
      });
    },
    version: "3"
  };
  globalThis[flagKey] = true;
}

module.exports = {
  DOM_HELPER_CHANNEL,
  DOM_HELPER_FLAG,
  DOM_HELPER_KEY,
  DOM_HELPER_TIMEOUT_MS,
  installBrowserDomHelper
};
