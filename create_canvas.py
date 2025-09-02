#!/usr/bin/env python3
"""
Generate an SVG with:
- Two circles, diameter 1.55 cm, spaced 36 + 21/32 inches center-to-center
- A centered rectangle 34" x 22"
- Rectangle center offset 30 mm (3 cm) below the circles' centerline

All computations are done in millimeters.
"""

from pathlib import Path

def main():
    inch_to_mm = 25.4

    # Dimensions (in millimeters)
    circle_d_mm = 15.5
    circle_r_mm = circle_d_mm / 2.0

    spacing_in = 36 + 21/32
    spacing_mm = spacing_in * inch_to_mm

    rect_w_in = 34
    rect_h_in = 22
    rect_w_mm = rect_w_in * inch_to_mm
    rect_h_mm = rect_h_in * inch_to_mm

    offset_mm = 30.0  # 3 cm downward (positive Y)

    # Positions (center layout on origin)
    half_sep = spacing_mm / 2.0
    left_cx = -half_sep
    right_cx = half_sep
    circles_cy = 0.0

    # Rectangle center is offset downward by 30 mm
    rect_cx = 0.0
    rect_cy = circles_cy + offset_mm
    rect_x = rect_cx - rect_w_mm / 2.0
    rect_y = rect_cy - rect_h_mm / 2.0

    # ViewBox padding
    pad = 10.0  # mm
    min_x = min(left_cx - circle_r_mm, rect_x) - pad
    max_x = max(right_cx + circle_r_mm, rect_x + rect_w_mm) + pad
    min_y = min(circles_cy - circle_r_mm, rect_y) - pad
    max_y = max(circles_cy + circle_r_mm, rect_y + rect_h_mm) + pad
    vb_w = max_x - min_x
    vb_h = max_y - min_y

    svg = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg"\n'
        f'     width="{vb_w:.6f}mm" height="{vb_h:.6f}mm"\n'
        f'     viewBox="{min_x:.6f} {min_y:.6f} {vb_w:.6f} {vb_h:.6f}">\n'
        '  <desc>\n'
        f'    Two circles (diameter {circle_d_mm} mm) spaced {spacing_mm:.6f} mm center-to-center;\n'
        f'    centered rectangle {rect_w_mm:.6f} mm × {rect_h_mm:.6f} mm,\n'
        f'    with its center {offset_mm:.6f} mm below the circles\' centers.\n'
        '    All units are millimeters.\n'
        '  </desc>\n'
        '  <g fill="none" stroke="#FFF" stroke-width="0.2" vector-effect="non-scaling-stroke">\n'
        '    <!-- Circles -->\n'
        f'    <circle cx="{left_cx:.6f}" cy="{circles_cy:.6f}" r="{circle_r_mm:.6f}" />\n'
        f'    <circle cx="{right_cx:.6f}" cy="{circles_cy:.6f}" r="{circle_r_mm:.6f}" />\n'
        '    <!-- Rectangle -->\n'
        f'    <rect x="{rect_x:.6f}" y="{rect_y:.6f}" width="{rect_w_mm:.6f}" height="{rect_h_mm:.6f}" />\n'
        '  </g>\n'
        '</svg>\n'
    )

    out = Path("nextdraw_canvas_template.svg")
    out.write_text(svg, encoding="utf-8")

    print("Wrote:", out.resolve())
    print({
        "circle_d_mm": circle_d_mm,
        "circle_r_mm": circle_r_mm,
        "spacing_mm": spacing_mm,
        "rect_w_mm": rect_w_mm,
        "rect_h_mm": rect_h_mm,
        "rect_center_offset_mm": offset_mm,
    })

if __name__ == "__main__":
    main()
