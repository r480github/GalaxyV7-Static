/*
 * svg-dom-shim.js
 *
 * Makes an SVG/foreignObject document behave enough like an HTML document for
 * a framework to run inside it. Load this as the FIRST classic script in the
 * foreignObject <head>, before any framework or app bundle.
 *
 * Two layers:
 *
 *   1. Document redirection. In an SVG document the document element is <svg>,
 *      so document.body / head / documentElement are null or wrong, and
 *      document.createElement produces null-namespace elements that never
 *      render. These get repointed into the foreignObject subtree and forced
 *      into the XHTML namespace. This much is enough for frameworks that build
 *      the DOM element by element (React, Preact, Vue).
 *
 *   2. innerHTML rescue. Layer 1 is NOT enough for Svelte 5 or Solid, which
 *      compile every component down to
 *
 *          var t = document.createElement("template");
 *          t.innerHTML = markup;
 *          return t.content;
 *
 *      The fragment-parsing algorithm picks XML vs HTML parsing from the node's
 *      DOCUMENT type, not its namespace, so in an XML document that markup gets
 *      XML-parsed: unclosed void elements (<br>, <input>) throw, and whatever
 *      does parse can land in the null namespace and silently never render.
 *
 *      DOMParser with "text/html" always runs the real HTML parser no matter
 *      which document calls it, so innerHTML is routed through it and the
 *      result imported back, arriving correctly namespaced.
 *
 * Layer 2 installs only when the native behavior is actually broken, so this
 * file is a no-op in a normal HTML document and safe to load unconditionally.
 */
(function () {
	'use strict';

	var XHTML_NS = 'http://www.w3.org/1999/xhtml';

	/* --- layer 1: point the document at the foreignObject subtree --------- */

	var fo = document.querySelector('foreignObject');
	if (!fo || !fo.firstElementChild) return; // already a real HTML document

	var root = fo.firstElementChild;
	var origCE = document.createElement.bind(document);
	var origCENS = document.createElementNS.bind(document);
	var origGetById = document.getElementById.bind(document);

	function define(name, getter) {
		Object.defineProperty(document, name, { get: getter, configurable: true });
	}

	define('head', function () {
		return root.querySelector('head');
	});
	define('body', function () {
		return root.querySelector('body');
	});
	define('documentElement', function () {
		return root;
	});

	document.createElement = function (tag, options) {
		return typeof tag === 'string' ? origCENS(XHTML_NS, tag, options) : origCE(tag, options);
	};

	document.createElementNS = function (ns, name, options) {
		return ns == null || ns === XHTML_NS
			? origCENS(XHTML_NS, name, options)
			: origCENS(ns, name, options);
	};

	Object.defineProperty(document, 'getElementById', {
		value: function (id) {
			// XML documents do not treat a plain id attribute as ID-typed without a
			// DTD, so the native lookup can miss elements that plainly have one.
			// Selector first, then an explicit scan, then the native call.
			var key = String(id);
			try {
				var esc = window.CSS && CSS.escape ? CSS.escape(key) : key;
				var hit = root.querySelector('#' + esc);
				if (hit) return hit;
			} catch (err) {
				/* not a valid selector -- fall through to the scan */
			}
			var all = root.querySelectorAll('[id]');
			for (var i = 0; i < all.length; i++) {
				if (all[i].id === key) return all[i];
			}
			// Reaches things outside the foreignObject, such as the element itself.
			return origGetById(key);
		},
		configurable: true,
		writable: true
	});

	document.getElementsByTagName = function (tag) {
		return root.getElementsByTagNameNS(XHTML_NS, tag);
	};
	document.getElementsByTagNameNS = function (ns, tag) {
		return root.getElementsByTagNameNS(ns, tag);
	};
	document.getElementsByClassName = function (cls) {
		return root.getElementsByClassName(cls);
	};

	var origQS = document.querySelector.bind(document);
	var origQSA = document.querySelectorAll.bind(document);

	document.querySelector = function (sel) {
		try {
			return root.querySelector(sel) || origQS(sel);
		} catch (err) {
			return origQS(sel);
		}
	};
	document.querySelectorAll = function (sel) {
		try {
			var found = root.querySelectorAll(sel);
			return found.length ? found : origQSA(sel);
		} catch (err) {
			return origQSA(sel);
		}
	};

	/* --- layer 2: route innerHTML through the real HTML parser ------------ */

	// Probe with exactly what Svelte emits. If a void element survives and lands
	// in the XHTML namespace, nothing below is needed.
	function nativeInnerHTMLWorks() {
		try {
			var t = origCENS(XHTML_NS, 'template');
			t.innerHTML = '<div><br></div>';
			var holder = t.content || t;
			var first = holder.firstChild;
			return !!first && first.namespaceURI === XHTML_NS;
		} catch (err) {
			return false;
		}
	}

	if (nativeInnerHTMLWorks()) return;

	var parser = new DOMParser();

	function parseAsHTML(markup) {
		// Wrapping in <template> preserves nodes the body parser would relocate,
		// such as a bare <tr> or <td>, which component templates legitimately hold.
		var doc = parser.parseFromString(
			'<!doctype html><body><template>' + markup + '</template></body>',
			'text/html'
		);
		return document.importNode(doc.querySelector('template').content, true);
	}

	var desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
	if (!desc || !desc.set) return;

	Object.defineProperty(Element.prototype, 'innerHTML', {
		configurable: true,
		enumerable: desc.enumerable,
		get: function () {
			return desc.get ? desc.get.call(this) : '';
		},
		set: function (markup) {
			// SVG-namespaced elements keep native behavior: their markup really is
			// XML, and rewriting it through the HTML parser would corrupt it.
			if (this.namespaceURI && this.namespaceURI !== XHTML_NS) {
				desc.set.call(this, markup);
				return;
			}

			// On a <template>, content belongs in .content, not the element.
			var target = this.content != null ? this.content : this;
			while (target.firstChild) target.removeChild(target.firstChild);

			if (markup === '' || markup == null) return;
			target.appendChild(parseAsHTML(String(markup)));
		}
	});
})();
