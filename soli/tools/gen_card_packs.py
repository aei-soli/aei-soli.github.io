#!/usr/bin/env python3
"""
gen_card_packs.py — derive attractive premium card-face packs from the BEAUTIFUL
classic deck already in web/assets/cards/.

Rather than redrawing cards from scratch, this keeps the classic full-colour courts
and pip layouts and restyles them via image compositing:
  • royal   — ivory/parchment stock + ornate gold double-frame
  • noir     — crisp white stock, higher-contrast grade, charcoal double-border
  • vintage  — warm sepia parchment stock + aged frame
  • phone    — classic art + bold high-contrast corner index badges (max legibility)

All packs preserve the source 500x726 size, transparent rounded corners, and red/black
suit legibility. Work is supersampled where we draw, and frames are drawn inside the
card silhouette so the renderer's rounded-corner clip still lines up.

Usage:
    python3 gen_card_packs.py                # generate all packs into ../assets/cards
    python3 gen_card_packs.py --sample       # write sample contact sheets to --sampledir
    python3 gen_card_packs.py --packs royal,phone
"""

import os, math, argparse
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.abspath(os.path.join(HERE, "..", "assets", "cards"))
W, H = 500, 726

SUITS = ["hearts", "diamonds", "clubs", "spades"]
RANKS = ["2","3","4","5","6","7","8","9","10","jack","queen","king","ace"]
RANK_DISP = {"jack":"J","queen":"Q","king":"K","ace":"A", **{str(n):str(n) for n in range(2,11)}}
RED = {"hearts","diamonds"}

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
def font(name, size): return ImageFont.truetype(os.path.join(FONT_DIR, name), int(size))
SANS_BOLD  = "DejaVuSans-Bold.ttf"
SERIF_BOLD = "DejaVuSerif-Bold.ttf"

# ── source art ─────────────────────────────────────────────────────────────────
def load_classic(rank, suit):
    return Image.open(os.path.join(CARDS, f"{rank}_of_{suit}.png")).convert("RGBA")

def silhouette(img):
    """Alpha channel of the source = the rounded card shape."""
    return img.split()[3]

# ── vector suit pip (for phone badges) ─────────────────────────────────────────
def _norm(pts, cx, cy, size):
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    s=size/max(max(xs)-min(xs), max(ys)-min(ys))
    mx=(max(xs)+min(xs))/2; my=(max(ys)+min(ys))/2
    return [(cx+(x-mx)*s, cy+(y-my)*s) for x,y in pts]

def _heart(flip=False):
    out=[]; t=0.0
    while t<=2*math.pi+0.001:
        x=16*math.sin(t)**3
        y=-(13*math.cos(t)-5*math.cos(2*t)-2*math.cos(3*t)-math.cos(4*t))
        out.append((x,-y if flip else y)); t+=0.05
    return out

def draw_pip(d, suit, cx, cy, size, color):
    if suit=="diamonds":
        r=size*0.52; rh=size*0.72
        d.polygon([(cx,cy-rh),(cx+r,cy),(cx,cy+rh),(cx-r,cy)], fill=color); return
    if suit=="hearts":
        d.polygon(_norm(_heart(False),cx,cy,size), fill=color); return
    if suit=="spades":
        d.polygon(_norm(_heart(True),cx,cy,size), fill=color)
        sw=size*0.07; sh=size*0.34; base=size*0.30; y0=cy+size*0.10
        d.polygon([(cx-sw,y0),(cx+sw,y0),(cx+base,y0+sh),(cx-base,y0+sh)], fill=color); return
    if suit=="clubs":
        r=size*0.27; off=size*0.26
        for lx,ly in [(cx,cy-off*1.05),(cx-off,cy+off*0.35),(cx+off,cy+off*0.35)]:
            d.ellipse([lx-r,ly-r,lx+r,ly+r], fill=color)
        sw=size*0.07; sh=size*0.40; base=size*0.26; y0=cy+off*0.30
        d.polygon([(cx-sw,y0),(cx+sw,y0),(cx+base,y0+sh),(cx-base,y0+sh)], fill=color); return

# ── compositing helpers ────────────────────────────────────────────────────────
def multiply_on_stock(art, stock_rgb):
    """Multiply-blend the art over a solid stock colour, masked to the card shape.
    White art areas take the stock colour; coloured pips/courts stay legible."""
    base = Image.new("RGB", art.size, stock_rgb)
    rgb  = Image.composite(art.convert("RGB"), base, silhouette(art))  # ignore transparent corners
    out  = Image.new("RGB", art.size)
    # multiply
    import PIL.ImageChops as ch
    out = ch.multiply(base, rgb)
    res = Image.new("RGBA", art.size, (0,0,0,0))
    res.paste(out, (0,0), silhouette(art))
    return res

def draw_frame(card, inset, radius, color, width, inner=True):
    """Draw a frame inside the card silhouette (so it follows the rounded corners)."""
    d = ImageDraw.Draw(card)
    d.rounded_rectangle([inset, inset, W-1-inset, H-1-inset], radius=radius, outline=color, width=width)
    if inner:
        i2 = inset + width + 6
        d.rounded_rectangle([i2, i2, W-1-i2, H-1-i2], radius=max(4,radius-6), outline=color, width=max(1,width//3))
    return card

def grade(art, contrast=1.0, color=1.0, brightness=1.0, warm=0.0):
    """Mild colour grade. `warm` shifts toward warm (>0) / cool (<0)."""
    rgb = art.convert("RGB")
    if contrast!=1.0:   rgb = ImageEnhance.Contrast(rgb).enhance(contrast)
    if color!=1.0:      rgb = ImageEnhance.Color(rgb).enhance(color)
    if brightness!=1.0: rgb = ImageEnhance.Brightness(rgb).enhance(brightness)
    if warm:
        r,g,b = rgb.split()
        r = r.point(lambda v: min(255, v+int(18*warm)))
        b = b.point(lambda v: max(0,   v-int(18*warm)))
        rgb = Image.merge("RGB",(r,g,b))
    out = Image.new("RGBA", art.size, (0,0,0,0))
    out.paste(rgb, (0,0), silhouette(art))
    return out

GOLD   = (176,142,47)
IVORY  = (250,245,232)
SEPIA  = (226,206,168)
SEPIA_FRAME = (139,102,56)
CHAR   = (32,32,42)

# ── corner index badge (phone pack) ────────────────────────────────────────────
def badge(rank, suit):
    """Return a small RGBA chip: rounded rect in suit colour with white rank + pip."""
    SS=4; bw,bh=120*SS,150*SS
    chip=Image.new("RGBA",(bw,bh),(0,0,0,0)); d=ImageDraw.Draw(chip)
    col=(206,28,28,255) if suit in RED else (24,24,32,255)
    d.rounded_rectangle([6*SS,6*SS,bw-6*SS,bh-6*SS], radius=22*SS, fill=col)
    f=font(SANS_BOLD, 78*SS)
    d.text((bw/2, 50*SS), RANK_DISP[rank], font=f, fill=(255,255,255,255), anchor="mm")
    draw_pip(d, suit, bw/2, bh-44*SS, 46*SS, (255,255,255,255))
    return chip.resize((bw//SS, bh//SS), Image.LANCZOS)

# ── styles ─────────────────────────────────────────────────────────────────────
def style_royal(rank, suit):
    art = load_classic(rank, suit)
    card = multiply_on_stock(art, IVORY)
    draw_frame(card, inset=20, radius=18, color=GOLD, width=5, inner=True)
    return card

def style_noir(rank, suit):
    art = grade(load_classic(rank, suit), contrast=1.18, color=1.05, brightness=0.99)
    card = art  # white stock kept for legibility
    draw_frame(card, inset=18, radius=16, color=CHAR, width=4, inner=True)
    return card

def style_vintage(rank, suit):
    art = grade(load_classic(rank, suit), contrast=1.05, color=0.88, warm=1.0)
    card = multiply_on_stock(art, SEPIA)
    draw_frame(card, inset=20, radius=16, color=SEPIA_FRAME, width=5, inner=True)
    # subtle aged vignette
    vig = Image.new("L",(W,H),0); ImageDraw.Draw(vig).rounded_rectangle([0,0,W-1,H-1],radius=26,fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(60))
    dark = Image.new("RGBA",(W,H),(60,40,20,40))
    card = Image.composite(Image.alpha_composite(card, dark), card, Image.eval(vig, lambda v:255-v))
    card.putalpha(silhouette(load_classic(rank,suit)))
    return card

def style_phone(rank, suit):
    # full-strength classic art; just add the bold high-contrast corner badges on top
    card = load_classic(rank, suit).copy()
    b = badge(rank, suit)
    card.alpha_composite(b, (16, 14))                                   # top-left
    card.alpha_composite(b.rotate(180), (W - b.width - 16, H - b.height - 14))  # bottom-right
    card.putalpha(silhouette(load_classic(rank, suit)))
    return card

STYLES = {"royal":style_royal, "noir":style_noir, "vintage":style_vintage, "phone":style_phone}

# ── drivers ────────────────────────────────────────────────────────────────────
def card_back(pack):
    img=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(img)
    if pack=="royal":
        d.rounded_rectangle([0,0,W-1,H-1],radius=26,fill=IVORY); draw_frame(img,20,18,GOLD,5)
        d.ellipse([W*0.34,H*0.40,W*0.66,H*0.60],outline=GOLD,width=4)
        d.text((W/2,H*0.5),"S",font=font(SERIF_BOLD,150),fill=GOLD,anchor="mm")
    elif pack=="noir":
        d.rounded_rectangle([0,0,W-1,H-1],radius=26,fill=(245,245,247,255)); draw_frame(img,18,16,CHAR,4)
        for i,r in enumerate(range(150,40,-30)):
            d.ellipse([W/2-r,H/2-r,W/2+r,H/2+r],outline=CHAR,width=3)
    elif pack=="vintage":
        d.rounded_rectangle([0,0,W-1,H-1],radius=26,fill=SEPIA); draw_frame(img,20,16,SEPIA_FRAME,5)
        for x in range(40,W-30,34):
            for y in range(40,H-30,34): d.ellipse([x-4,y-4,x+4,y+4],fill=SEPIA_FRAME)
    else:  # phone
        d.rounded_rectangle([0,0,W-1,H-1],radius=26,fill=(22,30,52,255))
        d.rounded_rectangle([18,18,W-19,H-19],radius=18,outline=(120,150,210,255),width=5)
        for i,r in enumerate(range(150,40,-32)):
            d.ellipse([W/2-r,H/2-r,W/2+r,H/2+r],outline=(90+i*16,120+i*14,205,255),width=4)
    return img

def gen_pack(pack):
    outdir=os.path.join(CARDS,pack); os.makedirs(outdir,exist_ok=True)
    fn=STYLES[pack]; n=0
    for s in SUITS:
        for r in RANKS:
            fn(r,s).save(os.path.join(outdir,f"{r}_of_{s}.png")); n+=1
    card_back(pack).save(os.path.join(outdir,"back.png"))
    print(f"  {pack}: {n} faces + back.png -> {outdir}")

def sample_sheet(packs, sampledir):
    os.makedirs(sampledir,exist_ok=True)
    cols=[("ace","spades"),("7","hearts"),("10","diamonds"),
          ("jack","clubs"),("queen","hearts"),("king","spades"),("BACK",None)]
    tw,th=210,305
    rows=["classic"]+packs
    sheet=Image.new("RGB",(len(cols)*tw, len(rows)*th),(40,78,54))
    for ri,pack in enumerate(rows):
        for ci,(r,s) in enumerate(cols):
            if r=="BACK":
                im = (Image.open(os.path.join(CARDS,"ace_of_spades.png")) if pack=="classic"
                      else card_back(pack)).convert("RGBA")
                if pack=="classic": im=Image.new("RGBA",(W,H),(0,0,0,0))
            elif pack=="classic":
                im=load_classic(r,s)
            else:
                im=STYLES[pack](r,s)
            im=im.convert("RGBA").resize((tw-12,th-12))
            bg=Image.new("RGBA",(tw-12,th-12),(255,255,255,255)); bg.alpha_composite(im)
            sheet.paste(bg.convert("RGB"),(ci*tw+6,ri*th+6))
    p=os.path.join(sampledir,"_packs_preview.png"); sheet.save(p); print("sample ->",p)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--packs",default=",".join(STYLES.keys()))
    ap.add_argument("--sample",action="store_true")
    ap.add_argument("--sampledir",default="/sessions/busy-relaxed-feynman/mnt/outputs")
    a=ap.parse_args()
    packs=[p.strip() for p in a.packs.split(",") if p.strip()]
    if a.sample: sample_sheet(packs, a.sampledir)
    else:
        for p in packs: gen_pack(p)
        print("done.")

if __name__=="__main__":
    main()
