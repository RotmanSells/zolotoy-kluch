#!/usr/bin/env python3
"""OCR menu images with Tesseract - file output mode"""

import subprocess
import re
import json
from pathlib import Path

IMAGES_DIR = Path('/Users/rotman/Downloads/AlibabaCatalog')
OUTPUT_FILE = Path('/Users/rotman/Desktop/Новая папка/menu_ocr_results.json')
TMP_BASE = '/tmp/ocr_out_'

IMAGE_FILES = sorted([f.name for f in IMAGES_DIR.glob('*.jpeg')
    if f.name.startswith(('229859ac','c3887ec2','1246e4d6','f4dc5e73','ea39e8d7',
    '7b392def','a6b37086','3cdaadc1','1dec9d13','7e4a5020','06227cd4','c3b8852b',
    '888512a8','b454dda1','e88d6258','7b61537d','0d340110','6949fc0e','f9aa16e7',
    'c2a2b2d4','b575b5fd','dec16e79','db219cb2','52de1cc1','fd272323','ed4fab89',
    'd6d0e97f'))])[:27]


def run_tesseract(img_path, idx):
    """Run Tesseract OCR via file output"""
    out_base = f'{TMP_BASE}{idx}'
    result = subprocess.run(
        ['tesseract', str(img_path), out_base, '-l', 'rus+eng', '--psm', '6', '--oem', '3'],
        capture_output=True, timeout=60
    )
    out_file = Path(f'{out_base}.txt')
    if out_file.exists():
        return out_file.read_text(encoding='utf-8', errors='replace')
    return ''


def parse_menu_text(text):
    """Parse OCR text into menu items. Handles multiple formats."""
    items = []
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]

    # Patterns for weight/price on a line
    # "300г/650р", "300г / 650р", "3002/700p", "Зшт/550р", "1 литр / 300р"
    patterns = [
        r'(\d{1,5})\s*(?:г|gr?)\s*/\s*(\d{1,5})\s*(?:₽|[рpPР])',           # 300г/650р
        r'(\d{1,5})\s*шт\s*/\s*(\d{1,5})\s*(?:₽|[рpPР])',                   # 3шт/550р
        r'(\d{1,5})\s*(?: литр| л|л)\s*/\s*(\d{1,5})\s*(?:₽|[рpPР])',       # 1 литр / 300р
        r'(\d{1,5})\s*(?:мл|ml)\s*/\s*(\d{1,5})\s*(?:₽|[рpPР])',            # 500мл/200р
        r'(\d{1,5})\s*/\s*(\d{1,5})\s*(?:₽|[рpPР])',                        # 3002/700p (OCR error)
        r'(\d{1,5})\s*/\s*(\d{1,5})\s*(?:р\b)',                              # 300/700р
    ]

    i = 0
    while i < len(lines):
        line = lines[i]

        matched = False
        for pat in patterns:
            wp_match = re.search(pat, line, re.IGNORECASE)
            if wp_match:
                weight_raw = wp_match.group(0).split('/')[0].strip()
                # Normalize weight
                if not any(u in weight_raw for u in ['г','л','мл','шт','л']):
                    weight_raw += 'г'
                price = int(wp_match.group(2))

                # Name: text before match
                name = line[:wp_match.start()].strip()
                name = re.sub(r'[|\\/\[\]{}®™—–\-]+$', '', name).strip()
                name = re.sub(r'^[\s|•\-–—]+', '', name).strip()
                name = re.sub(r'\s+', ' ', name)

                # Description: next non-empty line that isn't another item
                desc = ''
                if i + 1 < len(lines):
                    nxt = lines[i + 1]
                    has_wp = any(re.search(p, nxt, re.IGNORECASE) for p in patterns)
                    if not has_wp and len(nxt) > 3:
                        desc = nxt
                        i += 1

                if name and len(name) > 1:
                    items.append({
                        'name': name,
                        'description': desc,
                        'weight': weight_raw,
                        'price': price
                    })
                matched = True
                break

        i += 1

    return items


def main():
    all_items = []
    raw_dir = OUTPUT_FILE.parent / 'ocr_raw'
    raw_dir.mkdir(exist_ok=True)

    for idx, fname in enumerate(IMAGE_FILES):
        img_path = IMAGES_DIR / fname
        if not img_path.exists():
            print(f'[{idx+1}/27] SKIP {fname[:25]}')
            continue

        print(f'[{idx+1}/27] {fname[:35]}...', end=' ', flush=True)

        text = run_tesseract(img_path, idx)

        # Save raw
        (raw_dir / f'{idx+1:02d}_{fname[:20]}.txt').write_text(text, encoding='utf-8')

        items = parse_menu_text(text)
        for item in items:
            item['source'] = fname
        all_items.extend(items)

        print(f'{len(items)} items')

    # Save JSON
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(all_items, f, ensure_ascii=False, indent=2)

    print(f'\n=== TOTAL: {len(all_items)} items ===')
    for i, item in enumerate(all_items, 1):
        print(f'{i:3d}. {item["name"]:<45} {item.get("weight",""):>6} {item.get("price",""):>5}₽  {item.get("description","")[:50]}')

    print(f'\nSaved: {OUTPUT_FILE}')


if __name__ == '__main__':
    main()
