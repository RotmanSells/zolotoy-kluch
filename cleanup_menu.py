#!/usr/bin/env python3
"""Deduplicate and clean OCR menu results"""

import json
import re
from pathlib import Path

INPUT = Path('/Users/rotman/Desktop/Новая папка/menu_ocr_results.json')
OUTPUT = Path('/Users/rotman/Desktop/Новая папка/menu_clean.json')

with open(INPUT, 'r', encoding='utf-8') as f:
    items = json.load(f)

print(f'Raw: {len(items)} items')

# Fix common OCR errors
NAME_FIXES = {
    'MACO ПО-(АФСКИ': 'МАСО ПО-АФСКИ',
    'MACO ПО-МОЖЯСЛРЫФСКИ': 'МАСО ПО-МОЖЯСЛРЫФСКИ',
    'к СЛЕЙК ИЗ СВИНИНЫ': 'ШАШЛЫК ИЗ СВИНИНЫ',
    'CINEHK \'MUHOH"': 'СТЕЙК МЯСНОЙ',
    'ЛАНТЕЛГИЗ IMOBAPLI': 'СТЕЙК ИЗ ГОВЯДИНЫ',
    'JAHTEIL V3 КОФИЦЫ': 'СТЕЙК ИЗ КУРИЦЫ',
    'CONTE': 'СТЕЙК',
    'YLOBAH \'TOBYPMA"': 'СТЕЙК ГОВЯЖИЙ',
    'CEMTA B CAUBOLHO-AUMOHHOM СОУСЕ': 'СТЕЙК В СЛИВОЧНО-ЛИМОННОМ СОУСЕ',
    'XAULAMA 3.': 'ХАШЛАМА',
    'ФОРШ': 'БОРЩ',
    'BYTAAMA': 'БУЗБАШ',
    'SOKA ФОЗБАШ': 'ШУРПА',
    'КОЧЯШЯ-БОЗЪЯШ': 'КОЙМАШ-БОЗБАШ',
    'SOKA ФОЗБАШ': 'ШУРПА',
    'ЗЕЧЕВИЧНЫЯ СУТ': 'ЧЕЧЕВИЧНЫЙ СУП',
    'РУЛЯ': 'ХУРМА',
    'ФЯСЛВУРМЯ H3 TOBLDUH BI': 'ФАРШИРОВАННАЯ ГОВЯДИНА',
    'IUAULALTK «ФОФАФО» HA МАНТАЛЕ': 'ШАШЛЫК "СОФА" НА МАНГАЛЕ',
    'WAULADIK LAADUAIMOP»': 'ШАШЛЫК ГОВЯЖИЙ',
    'CYITCOATHKA': 'СОЛЯНКА',
    'СУТЛЯЛШЯ HA KY PH HOM БУЛЬОНЕ': 'СУТЛЯЧА НА КУРИНОМ БУЛЬОНЕ',
    'j CYT СОЛЯНКА (ХАЛЯЯЛФ)': 'СУП СОЛЯНКА (ХАЛЯЛЬ)',
    'ЖФК Е B ГОФОШОЧКЕ': 'ЖАРЕНОЕ В ГОФОШКЕ',
    'CARD КУФИНЫЯ': 'ЧАЙХАНА КУРИНЫЙ',
    'САЖФ H3 TOBLDUHBI': 'ЧАЙХАНА ИЗ ГОВЯДИНЫ',
    'CAKD KH т': 'ЧАЙХАНА',
    'CAKD ИЗЪФЯФАНИНЫ': 'ЧАЙХАНА ИЗ БАРАНИНЫ',
    'СЯЖФ АССОФЛЕИ': 'ЧАЙХАНА АССОРТИ',
    'САЖФ ЯССОФЛЕИ ХАЛЯЛЬ': 'ЧАЙХАНА АССОФЛЕИ ХАЛЯЛЬ',
    'OBOULHOE ACCOPITH BAKHHCKOE': 'ОВОЩНОЕ АССОРТИ БАКИНСКОЕ',
    'BAKWHCKOE СОЛЕНЫЪЕ ЯССОФЛЕИ': 'БАКИНСКОЕ СОЛЁНОЕ АССОРТИ',
    'ChIP BAKY>': 'СЫР БАКУ',
    'ФУССКЯЯЗЯКУСКЯ': 'РЫБНАЯ ЗАКУСКА',
    'Z „ЯЗЫКЛО-КАВКАЗСКИ': 'ЯЗЫК ПО-КАВКАЗСКИ',
    'OBOULHOE ACCOPITH BAKHHCKOE': 'ОВОЩНОЕ АССОРТИ БАКИНСКОЕ',
    'KABKASCKALAETEHDA': 'КАВКАЗСКАЯ ЛЕГЕНДА',
    'САЛЯЛГ«ВКУСНЯШКА»': 'САЛАТ "ВКУСНЯШКА"',
    'ЛЕЕПЛЬЯ САЛЯЯТ С ЛВЕЛЯЛЕИНОЙ': 'БОЛЬШОЙ САЛАТ С ЛОЖОЧКОЙ',
    'САЛЯЛГ«КАФМЕЬ': 'САЛАТ "КАВКАЗ"',
    'САЛЯШ SIBUAUCH>': 'САЛАТ СИБИРСКИЙ',
    'САЛЯШ «ЧЕМФЕФС»': 'САЛАТ "ШЕФ"',
    'ОШ DUPEKINOPA ФЕСУПОФАНЯ «ЗОО КЮ': 'ШЕФ-ПОВАРА "ЗОЛОТОЙ КЛЮЧ"',
    'XALATIYV PU ПО-АФЖАФСКИ': 'ХАЛАТЫ ПО-АФГАНСКИ',
    'XALATIY PH ПО-МЕТФЕЛЬСКИ': 'ХАЛАТЫ ПО-МЕТФЕЛЬСКИ',
    'ЛЮЛЯ-КЕБЯФ ИЗ КУРИЦЫ': 'ЛЮЛЯ-КЕБАБ ИЗ КУРИЦЫ',
    'WAUALIK ИЗ HHDEHKH': 'ШАШЛЫК ИЗ ИНДЕЙКИ',
    'UAULALIK ИЗ СЕМТИ': 'ШАШЛЫК ИЗ СЕМГИ',
    'IUAULALTK «ФОФАФО» HA МАНТАЛЕ': 'ШАШЛЫК "СОФА" НА МАНГАЛЕ',
    'WAULADIK LAADUAIMOP»': 'ШАШЛЫК ГОВЯЖИЙ',
    'UEIMPYHDEAD': 'ЧЕБУРЕКИ',
    'ЧИЗКЕЙК.': 'ЧИЗКЕЙК',
    'ФЯФЕНЬЕ': 'ФАФЕНИ',
    'ФЯСЛВУРМЯ H3 TOBLDUH BI': 'ФАРШИРОВАННАЯ ГОВЯДИНА',
    'YKYC OCHMHHOTA': 'ЗАКУСКА ОСЬМИНОГА',
    'BOCMOVHAL СКАЗКА': 'ВОСЬМОЙ СКАЗКА',
    'ДЕЗЯФЪ С CEMTOH': 'ЗВЕЗДА С СЕМГОЙ',
    'ЗДЕЗЯФЬ С КРЕВЕТКАМИ': 'ЗВЕЗДА С КРЕВЕТКАМИ',
    'CANASTIE HATIOAEOH"': 'САЛАТ ПОЛНЫЙ',
    'МОРСКОЙ KOKIMEHAD': 'МОРСКОЙ КОКТЕЙЛЬ',
    'ЗМЕФЕЖЕЛИНОЕ THEZDO': 'ЗВЕЗДНОЕ НЕБО',
    'САЛЯТ «РУККОЛЯ»': 'САЛАТ "РУКОЛЛА"',
    'СУПФЮЩЬБЯЕЯ': 'СУП ПЕЛЬМЕННЫЙ',
    'ЖУЛФЕЯ ПРИБНОХ': 'ЖУЛЬЕН ГРИБНОЙ',
    'ЖОЛЬЕНИЗЯЗЫКЯ': 'ЖУЛЬЕН ИЗ ЯЗЫКА',
    'ЖУЛФЕН АССОФЛЕИ': 'ЖУЛЬЕН АССОРТИ',
    'ЖУЛЪЕНКУФИНЫЙ': 'ЖУЛЬЕН КУРИНЫЙ',
    'ЖУЛЪЕНТРИБНОЙ': 'ЖУЛЬЕН ГРИБНОЙ',
    'ЖУЛЬЕНИЗ ЯЗЫКЯ': 'ЖУЛЬЕН ИЗ ЯЗЫКА',
    'ЖУЛФЕЛ ACCOPITA': 'ЖУЛЬЕН АССОРТИ',
    'CARD КУФИНЫЯ': 'ЧАЙХАНА КУРИНЫЙ',
    'САЖФ H3 TOBLDUHBI': 'ЧАЙХАНА ИЗ ГОВЯДИНЫ',
    'CAKD KH т': 'ЧАЙХАНА',
    'CAKD ИЗЪФЯФАНИНЫ': 'ЧАЙХАНА ИЗ БАРАНИНЫ',
    'СЯЖФ АССОФЛЕИ': 'ЧАЙХАНА АССОРТИ',
    'САЖФ ЯССОФЛЕИ ХАЛЯЛЬ': 'ЧАЙХАНА АССОФЛЕИ ХАЛЯЛЬ',
}

# Clean names
for item in items:
    name = item['name']
    # Apply fixes
    for bad, good in NAME_FIXES.items():
        if bad in name:
            name = good
            break
    # Remove leading artifacts
    name = re.sub(r'^[\s|•\-–—:;_=./\\]+', '', name).strip()
    name = re.sub(r'[\s|•\-–—:;_=./\\]+$', '', name).strip()
    # Fix double spaces
    name = re.sub(r'\s+', ' ', name)
    # Remove trailing punctuation artifacts
    name = re.sub(r'[.,;:]+$', '', name).strip()
    item['name'] = name.upper().strip()

    # Clean description
    desc = item.get('description', '')
    desc = re.sub(r'[|\\/\[\]{}®™—–\-\n]+', ' ', desc).strip()
    desc = re.sub(r'\s+', ' ', desc)
    item['description'] = desc

# Deduplicate by name (keep first occurrence)
seen = {}
deduped = []
for item in items:
    key = item['name']
    if key not in seen:
        seen[key] = True
        deduped.append(item)

print(f'Deduped: {len(deduped)} items')

# Categorize by looking at source file or keywords
def categorize(item):
    name = item['name'].upper()
    desc = item.get('description', '').upper()
    combined = name + ' ' + desc

    if any(w in combined for w in ['САЛАТ', 'САЛЯТ', 'САЛЯЛГ', 'ОВОЩНОЕ АССОРТИ', 'БАКИНСКОЕ СОЛЁНОЕ']):
        return 'salads'
    elif any(w in combined for w in ['СУП', 'СУПФЮЩЬБЯЕЯ', 'СОЛЯНКА', 'БОРЩ', 'ШУРПА', 'ХАШЛАМА', 'БУЗБАШ', 'ХУРМА', 'Коймаш', 'СУТЛЯЧА', 'ЧЕЧЕВИЧНЫЙ']):
        return 'soups'
    elif any(w in combined for w in ['ШАШЛЫК', 'WAUALIK', 'UAULALIK', 'ЛЮЛЯ-КЕБАБ', 'ФАРШИРОВАННАЯ', 'СТЕЙК', 'МАСО', 'ЯЗЫК', 'ХАЛЯЛЬ']):
        return 'grill'
    elif any(w in combined for w in ['ЖУЛЬЕН', 'ЖУЛФЕН', 'ЖУЛЪЕН', 'ЖОЛЬЕНИЗЯЗЫКЯ', 'ЖУЛФЕЯ ПРИБНОХ']):
        return 'hot_starters'
    elif any(w in combined for w in ['КРЕВЕТКИ', 'СЫФКОСИЧКЯ', 'СЕМЕЧКИ', 'КРЫЛЬЯ', 'Осьминог', 'МОРОЖЕНОЕ', 'ЧЕБУРЕКИ', 'ФАФЕНИ', 'ЧИЗКЕЙК']):
        return 'starters'
    elif any(w in combined for w in ['НАПИТКИ', 'СОКИ', 'ВОДА', 'ЧАЙ', 'ЧЯЙЗЕЛЕНЫЯ', 'ЧАЙХАНА', 'КОКЛЕЕЯЛЬ', 'ЧАЙ']):
        return 'drinks'
    elif any(w in combined for w in ['ХЛЕБ', 'ЛЕЛЁТИКЯ', 'ПАСТА', 'ХАЛАТЫ', 'КАРТОФЕЛЬ']):
        return 'sides'
    else:
        return 'hot_starters'

for item in deduped:
    item['category'] = categorize(item)

# Count by category
cats = {}
for item in deduped:
    c = item['category']
    cats[c] = cats.get(c, 0) + 1

print('\nBy category:')
for c, n in sorted(cats.items()):
    print(f'  {c}: {n}')

# Save
with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(deduped, f, ensure_ascii=False, indent=2)

print(f'\nSaved: {OUTPUT}')
print('\nSample items:')
for item in deduped[:15]:
    print(f'  {item["name"]:<50} {item.get("weight",""):>6} {item.get("price",""):>5}₽')
