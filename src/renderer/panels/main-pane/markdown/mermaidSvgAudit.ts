/** Self-contained: also runs inside the opaque Mermaid frame. No diagram-source parsing. */
export function auditMermaidSvg(svg: string): string {
  const fail = (detail: string): never => { throw new Error(`Unsupported Mermaid resource or markup: ${detail}`); };
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) fail('invalid SVG');
  const elements = [root, ...root.querySelectorAll('*')];
  const ids = new Set(elements.map((element) => element.id).filter(Boolean));
  const tags = new Set(('svg g defs title desc metadata style symbol use path rect circle ellipse line polyline polygon text tspan textPath marker clipPath mask pattern linearGradient radialGradient stop filter feDropShadow feGaussianBlur feOffset feBlend feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feFlood feMerge feMergeNode feMorphology feTurbulence feDisplacementMap feConvolveMatrix feDiffuseLighting feSpecularLighting feDistantLight fePointLight feSpotLight').split(' '));
  const attributes = new Set(('id class role name viewBox preserveAspectRatio width height x y x1 x2 y1 y2 cx cy r rx ry d points transform dx dy rotate textLength lengthAdjust refX refY markerUnits markerWidth markerHeight orient pathLength startOffset method spacing gradientUnits gradientTransform spreadMethod offset patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits in in2 result stdDeviation mode type values slope intercept amplitude exponent tableValues operator k1 k2 k3 k4 radius baseFrequency numOctaves seed stitchTiles scale xChannelSelector yChannelSelector order kernelMatrix divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha surfaceScale diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation z pointsAtX pointsAtY pointsAtZ').split(' '));
  // These CSS properties cannot fetch resources. Everything else fails closed;
  // paint/reference/image properties below receive semantic value validation.
  const css = new Set(('font-family font-size font-style font-weight font-variant font-stretch font-feature-settings font-kerning line-height letter-spacing word-spacing text-anchor text-align text-decoration text-transform text-rendering dominant-baseline alignment-baseline white-space word-break overflow-wrap color background-color opacity fill-opacity fill-rule stroke-opacity stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-rule flood-color flood-opacity stop-color stop-opacity lighting-color visibility display position top right bottom left width height min-width min-height max-width max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color border-top-left-radius border-top-right-radius border-bottom-right-radius border-bottom-left-radius border-image-slice border-image-width border-image-outset border-image-repeat background-position-x background-position-y background-size background-repeat background-attachment background-origin background-clip box-shadow box-sizing pointer-events z-index overflow overflow-x overflow-y vertical-align transform transform-origin transform-box vector-effect paint-order shape-rendering isolation mix-blend-mode rx ry').split(' '));
  const references = new Set(['marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter']);
  const isFragment = (value: string) => /^#[\p{L}\p{N}_.:-]+$/u.test(value);
  const fragment = (value: string) => isFragment(value) && ids.has(value.slice(1));
  const urlTarget = (value: string) => {
    if (!value.startsWith('url(') || !value.endsWith(')')) return '';
    let target = value.slice(4, -1).trim();
    if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) target = target.slice(1, -1);
    return isFragment(target) ? target : '';
  };
  const localUrl = (value: string) => fragment(urlTarget(value));
  const color = document.createElement('span').style;
  const checkValue = (property: string, value: string) => {
    if (property === 'fill' || property === 'stroke') {
      if (value === 'none' || value === 'currentcolor' || value === 'currentColor' || localUrl(value)) return;
      // CSSOM color parsing accepts var()/attr(); those could resolve to a URL
      // when transplanted into the parent, so never export unresolved paint.
      if (value.includes('\\') || /(?:var|env|attr)\s*\(/i.test(value)) fail(property);
      color.color = '';
      color.color = value;
      if (!color.color) fail(property);
      return;
    }
    if (references.has(property)) {
      if (property === 'filter') {
        // Mermaid ships unused #drop-shadow rules alongside namespaced filters.
        // A missing target does nothing in the frame; never let it bind outside
        // this SVG after export. Preserve that behavior with an explicit none.
        if (urlTarget(value) && !localUrl(value)) return 'none';
        if (value.startsWith('drop-shadow(') && value.endsWith(')')) {
          const shadow = document.createElement('span').style;
          shadow.textShadow = value.slice(12, -1);
          if (shadow.textShadow && !value.includes('\\') && !/(?:var|env|attr)\s*\(/i.test(value)) return;
        }
      }
      if (value !== 'none' && !localUrl(value)) fail(property);
      return;
    }
    if (property === 'background-image' || property === 'border-image-source') {
      if (value !== 'none' && value !== 'initial') fail(property);
      return;
    }
    if (property === 'cursor') {
      if (!['auto', 'default', 'pointer', 'text', 'crosshair', 'move', 'not-allowed'].includes(value)) fail(property);
      return;
    }
    // The one Mermaid custom property is only used by non-resource font-family.
    if (property === '--mermaid-font-family') {
      const font = document.createElement('span').style;
      font.fontFamily = value;
      if (!font.fontFamily || value.includes('\\') || /(?:url|var|attr)\s*\(/i.test(value)) fail(property);
      return;
    }
    if (!css.has(property)) fail(property);
  };
  const checkStyle = (style: CSSStyleDeclaration) => {
    for (let i = style.length - 1; i >= 0; i--) {
      const property = style[i];
      // Export static diagrams. Animation names could bind to a parent sheet;
      // dropping these declarations also prevents post-audit attribute changes.
      if (property.startsWith('animation-') || property === 'animation') style.removeProperty(property);
      else {
        const replacement = checkValue(property, style.getPropertyValue(property).trim());
        if (replacement) style.setProperty(property, replacement, style.getPropertyPriority(property));
      }
    }
  };
  for (const element of elements) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || !tags.has(element.localName)) fail(element.localName);
    for (const attribute of [...element.attributes]) {
      const { name, value } = attribute;
      if (name === 'xmlns' && value === 'http://www.w3.org/2000/svg') continue;
      if (name === 'xmlns:xlink' && value === 'http://www.w3.org/1999/xlink') continue;
      if ((name === 'href' || name === 'xlink:href') && fragment(value)) continue;
      if (name === 'style') {
        const style = document.createElement('span').style;
        style.cssText = value;
        checkStyle(style);
        element.setAttribute(name, style.cssText);
      } else if (css.has(name) || references.has(name) || name === 'fill' || name === 'stroke') {
        const replacement = checkValue(name, value.trim());
        if (replacement) element.setAttribute(name, replacement);
      } else if (!attributes.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) fail(name);
    }
    if (element.localName === 'style') {
      // Parse through the browser's CSSOM in the already CSP-restricted realm.
      // An inactive sheet cannot fetch while it is being inspected.
      const style = document.createElement('style');
      style.media = 'not all';
      style.textContent = element.textContent;
      document.head.append(style);
      try {
        const sheet = style.sheet;
        if (!sheet) fail('stylesheet');
        const checkRules = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule.type === 1) {
              checkStyle((rule as CSSStyleRule).style);
              const nested = (rule as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules;
              if (nested) checkRules(nested);
            }
            else if (rule.type === 7) { // keyframes never leave the frame
              for (const keyframe of Array.from((rule as CSSKeyframesRule).cssRules)) checkStyle((keyframe as CSSKeyframeRule).style);
            } else fail(`CSS rule ${rule.type}`);
          }
        };
        checkRules(sheet!.cssRules);
        element.textContent = Array.from(sheet!.cssRules).filter((rule) => rule.type === 1).map((rule) => rule.cssText).join('\n');
      } finally { style.remove(); }
    }
  }
  return new XMLSerializer().serializeToString(root);
}
