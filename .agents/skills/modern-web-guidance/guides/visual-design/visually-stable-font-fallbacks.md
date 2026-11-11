# Visually Stable Font Fallbacks

When web fonts load, they often replace a fallback font that has different dimensions, even if both are set to the same `font-size`. This causes "layout shift" (Cumulative Layout Shift) and can make text illegible if the fallback's lowercase letters (x-height) are significantly different than the preferred font.

The `font-size-adjust` property can keep a selected font metric, usually x-height, consistent across fonts. It does not guarantee equal glyph widths or prevent all layout shifts.

## Implementation steps

### 1. Identify the aspect ratio of your preferred font
To normalize fallbacks, you need the "aspect value" (the ratio of lowercase letters to the font size) of your primary font.

*   **Numeric value:** Measure the primary font's x-height and divide it by the font size. Use this value to scale fallback fonts, including while the primary font loads.
*   **`from-font` limit:** This keyword reads the first available font. If the primary font is unavailable, it uses the fallback font's metric and cannot match the unavailable font.

### 2. Apply font-size-adjust to the text container
Apply the property to the element or a parent container. This ensures that if the primary font fails to load or is in the process of loading, the fallback font is scaled to match the visual size of the primary font.

```css
.text-content {
  /* Define your font stack as usual */
  font-family: "MyWebFont", "Arial", sans-serif;
  font-size: 1rem;

  /* Example only: replace 0.5 with MyWebFont's measured x-height / font-size. */
  font-size-adjust: 0.5;
}
```

### 3. (Optional) Adjust for specific metrics
While x-height is the default and most common, you can normalize by other metrics like `cap-height` (useful for all-caps headers) or `ch-width` (useful for monospaced fonts).

```css
h1 {
  /* Example only: replace 0.7 with the primary font's measured cap-height / font-size. */
  font-size-adjust: cap-height 0.7;
}
```

### 4. Verify visual stability
Ensure that the `font-size-adjust` value correctly aligns the fallback. You can test this by temporarily blocking the web font or adjusting the `font-family` declaration in your browser's DevTools and verifying that the text layout remains stable.

## Fallback strategies

Baseline status for font-size-adjust: Newly available. It's been Baseline since 2024-07-25.
Supported by: Chrome 127 (Jul 2024), Edge 127 (Jul 2024), Firefox 118 (Sep 2023), and Safari 17 (Sep 2023).

In browsers that do not support `font-size-adjust`, the font will be rendered at its default scale. This may result in layout shifts or changes in readability during font swaps.

To mitigate this without `font-size-adjust`, you can use the `@font-face` descriptors `size-adjust`, `ascent-override`, and `descent-override` to manually tune fallback fonts, though these are more complex to calculate than a single `font-size-adjust` value.
