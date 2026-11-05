/**
 * layout-debug.js
 * Temporary diagnostic script to log viewport and element dimensions 
 * for Android landscape layout debugging.
 */
console.log("LAYOUT_DEBUG_LOADED");

(function() {
    'use strict';

    function runDiagnostics() {
        try {
            console.group('%c[Layout Debugger] --- POS Screen Audit ---', 'background: #000; color: #0ff; padding: 4px; font-weight: bold;');

            // 1. Viewport metrics
            console.group('Viewport Measurements');
            console.log('window.innerWidth:', window.innerWidth);
            console.log('window.innerHeight:', window.innerHeight);
            console.log('window.visualViewport?.width:', window.visualViewport?.width);
            console.log('window.visualViewport?.height:', window.visualViewport?.height);
            console.log('document.documentElement.clientHeight:', document.documentElement?.clientHeight);
            console.log('document.body.clientHeight:', document.body?.clientHeight);
            console.groupEnd();

            // 2. Target elements list
            const selectors = [
                '#app',
                '.topbar',
                '.pos-layout',
                '.cart-panel',
                '.cart-items',
                '.payment-box',
                '#payBtn'
            ];

            console.group('Element Measurements');
            selectors.forEach(selector => {
                const el = document.querySelector(selector);
                if (!el) {
                    console.warn(`[Missing] Element not found in DOM: ${selector}`);
                    return;
                }

                const rect = el.getBoundingClientRect();
                const computed = window.getComputedStyle(el);

                console.groupCollapsed(`Element: ${selector}`);
                console.log('getBoundingClientRect():', {
                    top: rect.top,
                    bottom: rect.bottom,
                    left: rect.left,
                    right: rect.right,
                    width: rect.width,
                    height: rect.height
                });
                console.log('clientHeight:', el.clientHeight);
                console.log('offsetHeight:', el.offsetHeight);
                console.log('getComputedStyle(el).height:', computed?.height);
                console.log('getComputedStyle(el).overflow:', computed?.overflow);
                console.log('getComputedStyle(el).position:', computed?.position);
                console.log('getComputedStyle(el).display:', computed?.display);
                console.groupEnd();
            });
            console.groupEnd();

            console.groupEnd();
        } catch (e) {
            console.error('[Layout Debugger] Error running diagnostics:', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(runDiagnostics, 300);
        });
    } else {
        setTimeout(runDiagnostics, 300);
    }
})();