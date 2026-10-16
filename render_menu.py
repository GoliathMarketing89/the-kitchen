#!/usr/bin/env python3
"""
The Kitchen — menu page generator.

Reads menu.json and renders a single self-contained index.html.
The Kitchen Manager edits menu.json, then runs this to regenerate the page,
then commits + pushes so GitHub Pages republishes.

Design: mobile-first, warm, minimal. Cream background, one soft accent,
big food photos, generous whitespace. Order button opens the shop's
WhatsApp chat with the order pre-typed.
"""
import json
import html
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
MENU = ROOT / "menu.json"
OUT = ROOT / "index.html"

ACCENT = "#b5651d"   # warm terracotta
CREAM = "#faf6f0"


def esc(s):
    return html.escape(str(s or ""), quote=True)


def wa_link(number, message):
    """Build a wa.me link for a (possibly country-code-less) number."""
    num = "".join(ch for ch in str(number) if ch.isdigit()).lstrip("0")
    return f"https://wa.me/{num}?text={_urlenc(message)}"


def _urlenc(msg):
    from urllib.parse import quote
    return quote(msg)


def render_card(item, shop):
    name = esc(item.get("name", "Dish"))
    desc = esc(item.get("description", ""))
    price = item.get("price", "")
    price_txt = f"{esc(item.get('currency', shop.get('currency','THB')))} {esc(price)}" if price else ""
    img = item.get("image", "")
    img_html = f'<div class="photo"><img src="{esc(img)}" alt="{name}" loading="lazy"></div>' if img else ''

    buttons = []
    # Order button -> WhatsApp, if the shop has an order number configured.
    wa = shop.get("order_whatsapp", "")
    if wa:
        msg = f"Hi! I'd like to order: {item.get('name','')}"
        buttons.append(f'<a class="order" href="{wa_link(wa, msg)}">{esc("Order")}</a>')
    # Without a number configured yet, fall back to a gentle cue.
    else:
        buttons.append('<span class="order off">Message to order</span>')

    return f"""
    <div class="card">
      {img_html}
      <div class="card-body">
        <div class="name-row"><h3>{name}</h3>{f'<span class="price">{price_txt}</span>' if price_txt else ''}</div>
        {f'<p class="desc">{desc}</p>' if desc else ''}
        <div class="actions">{''.join(buttons)}</div>
      </div>
    </div>"""


def render():
    with open(MENU) as f:
        data = json.load(f)
    shop = data.get("shop", {})
    sections = data.get("sections", [])

    shop_name = esc(shop.get("name", "The Kitchen"))
    tagline = esc(shop.get("tagline", ""))
    pickup = esc(shop.get("pickup_note", ""))

    section_html = ""
    for sec in sections:
        items = sec.get("items", [])
        if not items:
            continue
        cards = "\n".join(render_card(it, shop) for it in items)
        note = esc(sec.get("note", ""))
        section_html += f"""
      <section>
        <div class="sec-head"><h2>{esc(sec.get('title',''))}</h2></div>
        {f'<p class="sec-note">{note}</p>' if note else ''}
        <div class="grid">{cards}</div>
      </section>"""

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{shop_name}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background:{CREAM}; color:#2b2b2b; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.5; }}
  .wrap {{ max-width:720px; margin:0 auto; padding:32px 20px 56px; }}
  header {{ text-align:center; margin-bottom:36px; }}
  header h1 {{ font-size:2rem; font-weight:600; letter-spacing:-0.02em; }}
  header p {{ color:#6b6b6b; margin-top:8px; }}
  .pickup {{ text-align:center; color:#6b6b6b; font-size:.95rem; margin-bottom:32px; padding:12px; background:#fff; border-radius:12px; }}
  section {{ margin-bottom:40px; }}
  .sec-head h2 {{ font-size:1.35rem; font-weight:600; position:relative; padding-bottom:10px; }}
  .sec-head h2::after {{ content:""; position:absolute; left:0; bottom:0; width:36px; height:3px; background:{ACCENT}; border-radius:2px; }}
  .sec-note {{ color:#6b6b6b; font-size:.92rem; margin:6px 0 16px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
  @media (max-width:480px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .card {{ background:#fff; border-radius:14px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.06); display:flex; flex-direction:column; }}
  .photo img {{ width:100%; height:150px; object-fit:cover; display:block; }}
  .card-body {{ padding:14px; display:flex; flex-direction:column; gap:8px; flex:1; }}
  .name-row {{ display:flex; justify-content:space-between; align-items:baseline; gap:8px; }}
  h3 {{ font-size:1.05rem; font-weight:600; }}
  .price {{ font-weight:600; color:{ACCENT}; white-space:nowrap; }}
  .desc {{ color:#6b6b6b; font-size:.9rem; }}
  .actions {{ margin-top:auto; }}
  .order {{ display:block; text-align:center; padding:10px; background:{ACCENT}; color:#fff; text-decoration:none; font-weight:600; border-radius:9px; font-size:.95rem; }}
  .order:active {{ transform:scale(.98); }}
  .order.off {{ background:#e8e2da; color:#8a857d; font-weight:500; }}
  footer {{ text-align:center; color:#9a958c; font-size:.85rem; margin-top:24px; }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>{shop_name}</h1>
      {f'<p>{tagline}</p>' if tagline else ''}
    </header>
    {f'<div class="pickup">{pickup}</div>' if pickup else ''}
    {section_html}
    <footer>Made with love. Questions? Just message.</footer>
  </div>
</body>
</html>"""
    with open(OUT, "w") as f:
        f.write(page)
    print(f"Wrote {OUT} ({len(page)} chars)")


if __name__ == "__main__":
    render()
