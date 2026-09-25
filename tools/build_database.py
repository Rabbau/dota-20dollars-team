#!/usr/bin/env python3
"""Сборка базы игроков для «Команда за $20: Dota 2».

Источники:
  * Liquipedia (MediaWiki API): рейтинг команд Portal:Rankings, составы команд
    (раздел «Active», шаблоны Squad/Person), инфобоксы игроков (запасной источник позиции).
  * Фото: основной источник — инфобоксы игроков на Liquipedia (лицензия «permission», права у
    авторов; некоммерческий фан-проект). Если там фото нет — Wikidata (P10918 -> P18) и
    Wikimedia Commons (только свободные лицензии). Иначе на сайте рисуется аватар.
  * tools/ratings.json — ручные рейтинги 0–99 (ключ — ник), tools/roles.json — ручные позиции.

Правила API Liquipedia: осмысленный User-Agent, gzip, не чаще 1 запроса в 2 с,
action=parse — не чаще 1 в 30 с, пауза и повтор на 429.

Запуск:  python tools/build_database.py [--teams N] [--no-photos]
"""
import argparse
import io
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests

try:
    from PIL import Image, ImageOps
except ImportError:  # Pillow необязателен
    Image = None

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
DATA = ROOT / "data" / "players.json"
IMG_DIR = ROOT / "img" / "players"
CREDITS_MD = IMG_DIR / "CREDITS.md"
PHOTOS_DB = TOOLS / "photos.json"
RATINGS = TOOLS / "ratings.json"
ROLES = TOOLS / "roles.json"
LEGENDS = TOOLS / "legends.json"
TRANSFERS = TOOLS / "transfers.json"

LP_API = "https://liquipedia.net/dota2/api.php"
LP_WIKI = "https://liquipedia.net/dota2/"
WD_SPARQL = "https://query.wikidata.org/sparql"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
UA = ("Team20DollarsDota2/1.0 (fan-made auction browser game; database builder; "
      "contact: oprovozenko@gmail.com) python-requests")

DEFAULT_RATING = 70
PHOTO_WIDTH = 360

# Файлы Commons, которые нельзя брать (групповые фото, однофамильцы, не тот человек).
BLOCKED_FILES = {
    "File:Emo-colao-bailando.jpg",  # случайные люди, «dota» только в описании
    "File:The International 2018 (30338896818).jpg",  # MidOne: команда за столами, групповое
    "File:The International 2018 (44180400692).jpg",  # No[o]ne-: двое в кадре, неоднозначно
    "File:The International 2018 (30302406438).jpg",  # Jabz: объятия, групповое
}

POS_NAMES = {1: "Керри", 2: "Мид", 3: "Оффлейн", 4: "Роумер / саппорт", 5: "Фулл-саппорт"}

COUNTRIES = {
    "ru": "Россия", "ua": "Украина", "by": "Беларусь", "kz": "Казахстан", "kg": "Киргизия",
    "uz": "Узбекистан", "tj": "Таджикистан", "tm": "Туркменистан", "am": "Армения",
    "az": "Азербайджан", "ge": "Грузия", "md": "Молдова", "mn": "Монголия", "ee": "Эстония",
    "lv": "Латвия", "lt": "Литва", "pl": "Польша", "cz": "Чехия", "sk": "Словакия",
    "de": "Германия", "at": "Австрия", "ch": "Швейцария", "fr": "Франция", "be": "Бельгия",
    "nl": "Нидерланды", "lu": "Люксембург", "gb": "Великобритания", "uk": "Великобритания",
    "en": "Англия", "sco": "Шотландия", "ie": "Ирландия", "dk": "Дания", "se": "Швеция",
    "no": "Норвегия", "fi": "Финляндия", "is": "Исландия", "es": "Испания", "pt": "Португалия",
    "it": "Италия", "gr": "Греция", "cy": "Кипр", "mt": "Мальта", "bg": "Болгария",
    "ro": "Румыния", "hu": "Венгрия", "rs": "Сербия", "hr": "Хорватия", "si": "Словения",
    "ba": "Босния и Герцеговина", "me": "Черногория", "mk": "Северная Македония",
    "al": "Албания", "xk": "Косово", "tr": "Турция", "il": "Израиль", "jo": "Иордания",
    "lb": "Ливан", "sy": "Сирия", "iq": "Ирак", "ir": "Иран", "sa": "Саудовская Аравия",
    "ae": "ОАЭ", "kw": "Кувейт", "qa": "Катар", "bh": "Бахрейн", "om": "Оман", "ye": "Йемен",
    "eg": "Египет", "ma": "Марокко", "tn": "Тунис", "dz": "Алжир", "za": "ЮАР", "pk": "Пакистан",
    "in": "Индия", "bd": "Бангладеш", "lk": "Шри-Ланка", "np": "Непал", "cn": "Китай",
    "tw": "Тайвань", "hk": "Гонконг", "mo": "Макао", "jp": "Япония", "kr": "Южная Корея",
    "my": "Малайзия", "sg": "Сингапур", "id": "Индонезия", "ph": "Филиппины", "th": "Таиланд",
    "vn": "Вьетнам", "mm": "Мьянма", "kh": "Камбоджа", "la": "Лаос", "au": "Австралия",
    "nz": "Новая Зеландия", "us": "США", "ca": "Канада", "mx": "Мексика", "gt": "Гватемала",
    "hn": "Гондурас", "sv": "Сальвадор", "cr": "Коста-Рика", "pa": "Панама", "cu": "Куба",
    "do": "Доминикана", "pr": "Пуэрто-Рико", "co": "Колумбия", "ve": "Венесуэла",
    "ec": "Эквадор", "pe": "Перу", "bo": "Боливия", "br": "Бразилия", "py": "Парагвай",
    "uy": "Уругвай", "ar": "Аргентина", "cl": "Чили",
}

# Инфобокс игрока пишет страну словом («Russia») — переводим в код флага.
COUNTRY_NAMES = {
    "russia": "ru", "ukraine": "ua", "belarus": "by", "kazakhstan": "kz", "kyrgyzstan": "kg",
    "uzbekistan": "uz", "armenia": "am", "georgia": "ge", "moldova": "md", "mongolia": "mn",
    "estonia": "ee", "latvia": "lv", "lithuania": "lt", "poland": "pl", "czech republic": "cz",
    "czechia": "cz", "slovakia": "sk", "germany": "de", "austria": "at", "switzerland": "ch",
    "france": "fr", "belgium": "be", "netherlands": "nl", "united kingdom": "gb", "england": "en",
    "ireland": "ie", "denmark": "dk", "sweden": "se", "norway": "no", "finland": "fi", "spain": "es",
    "portugal": "pt", "italy": "it", "greece": "gr", "bulgaria": "bg", "romania": "ro", "hungary": "hu",
    "serbia": "rs", "croatia": "hr", "slovenia": "si", "bosnia and herzegovina": "ba",
    "north macedonia": "mk", "macedonia": "mk", "turkey": "tr", "israel": "il", "jordan": "jo",
    "lebanon": "lb", "syria": "sy", "iraq": "iq", "iran": "ir", "saudi arabia": "sa",
    "united arab emirates": "ae", "egypt": "eg", "pakistan": "pk", "india": "in", "china": "cn",
    "taiwan": "tw", "hong kong": "hk", "japan": "jp", "south korea": "kr", "korea": "kr",
    "malaysia": "my", "singapore": "sg", "indonesia": "id", "philippines": "ph", "thailand": "th",
    "vietnam": "vn", "myanmar": "mm", "cambodia": "kh", "laos": "la", "australia": "au",
    "new zealand": "nz", "united states": "us", "usa": "us", "canada": "ca", "mexico": "mx",
    "colombia": "co", "venezuela": "ve", "ecuador": "ec", "peru": "pe", "bolivia": "bo",
    "brazil": "br", "paraguay": "py", "uruguay": "uy", "argentina": "ar", "chile": "cl",
}

ROLE_WORDS = [
    (re.compile(r"hard\s*support|full\s*support|position\s*5|pos\s*5", re.I), 5),
    (re.compile(r"soft\s*support|roam|position\s*4|pos\s*4", re.I), 4),
    (re.compile(r"off\s*lane|offlaner|position\s*3|pos\s*3", re.I), 3),
    (re.compile(r"\bmid|solo\s*middle|position\s*2|pos\s*2", re.I), 2),
    (re.compile(r"carry|safe\s*lane|position\s*1|pos\s*1", re.I), 1),
    (re.compile(r"support", re.I), 4),
]


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- HTTP ----
class Client:
    def __init__(self, min_interval):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Encoding": "gzip"})
        self.min_interval = min_interval
        self.last = 0.0

    def get(self, url, params=None, interval=None, tries=6, **kw):
        interval = self.min_interval if interval is None else interval
        for attempt in range(tries):
            wait = self.last + interval - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(url, params=params, timeout=60, **kw)
            except requests.RequestException as e:
                log(f"  ! сеть: {e}; повтор")
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                pause = int(r.headers.get("Retry-After", 0) or 0) or 30 * (attempt + 1)
                log(f"  ! HTTP {r.status_code}, пауза {pause} с")
                time.sleep(pause)
                continue
            r.raise_for_status()
            return r
        raise RuntimeError(f"не удалось получить {url}")


LP = Client(2.1)          # Liquipedia: не чаще 1 запроса в 2 с
LP_PARSE_INTERVAL = 31    # action=parse — не чаще 1 в 30 с
WM = Client(1.0)          # Wikidata / Commons


def lp_query(**params):
    params.update(format="json", formatversion="2")
    return LP.get(LP_API, params).json()


def lp_parse(page, text=None):
    params = dict(action="parse", prop="text", format="json", formatversion="2")
    if text is None:
        params["page"] = page
    else:  # отрисовать вики-текст в контексте страницы
        params.update(title=page, text=text, contentmodel="wikitext")
    wait = LP.last + LP_PARSE_INTERVAL - time.time()
    if wait > 0:
        time.sleep(wait)
    r = LP.get(LP_API, params, interval=LP_PARSE_INTERVAL)
    LP.last = time.time()
    return r.json()["parse"]["text"]


def lp_wikitext(titles):
    """Вики-текст страниц пачками до 50 названий. Возвращает {запрошенное: (итоговое, текст)}."""
    out = {}
    titles = list(dict.fromkeys(titles))
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        d = lp_query(action="query", prop="revisions", rvprop="content", rvslots="main",
                     redirects="1", titles="|".join(chunk))
        q = d.get("query", {})
        alias = {}
        for key in ("normalized", "redirects"):
            for x in q.get(key, []):
                alias[x["from"]] = x["to"]
        pages = {p["title"]: p for p in q.get("pages", [])}
        for t in chunk:
            final = t
            for _ in range(5):
                if final in alias:
                    final = alias[final]
            p = pages.get(final)
            if p and "revisions" in p:
                out[t] = (final, p["revisions"][0]["slots"]["main"]["content"])
            else:
                out[t] = (final, None)
    return out


# ------------------------------------------------------- wikitext utils ----
def templates(text, name):
    """Все вхождения шаблона {{name ...}} с учётом вложенности."""
    res = []
    pat = re.compile(r"\{\{\s*" + re.escape(name) + r"\s*[|}]", re.I)
    for m in pat.finditer(text):
        i, depth, j = m.start(), 0, m.start()
        while j < len(text):
            if text.startswith("{{", j):
                depth += 1
                j += 2
            elif text.startswith("}}", j):
                depth -= 1
                j += 2
                if depth == 0:
                    res.append(text[i:j])
                    break
            else:
                j += 1
    return res


def params(tpl):
    """Именованные параметры шаблона верхнего уровня."""
    body = tpl[2:-2]
    parts, depth, cur, k = [], 0, [], 0
    while k < len(body):
        two = body[k:k + 2]
        if two in ("{{", "[["):
            depth += 1
            cur.append(two)
            k += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            cur.append(two)
            k += 2
            continue
        ch = body[k]
        if ch == "|" and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        k += 1
    parts.append("".join(cur))
    out = {}
    for p in parts[1:]:
        if "=" in p:
            key, val = p.split("=", 1)
            out[key.strip().lower()] = val.strip()
    return out


def clean(v):
    v = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", v or "", flags=re.S)
    v = re.sub(r"<!--.*?-->", "", v, flags=re.S)
    v = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", v)
    v = re.sub(r"\{\{[^{}]*\}\}", "", v)
    v = re.sub(r"<[^>]+>", "", v)
    return v.strip()


def section(text, header):
    m = re.search(r"^(=+)\s*" + re.escape(header) + r"\s*\1\s*$", text, re.M)
    if not m:
        return None
    level = len(m.group(1))
    rest = text[m.end():]
    n = re.search(r"^={1,%d}[^=].*?=+\s*$" % level, rest, re.M)
    return rest[:n.start()] if n else rest


def role_from(value):
    value = clean(value)
    m = re.match(r"\s*([1-5])", value)
    if m:
        return int(m.group(1))
    for rx, pos in ROLE_WORDS:
        if rx.search(value):
            return pos
    return None


PATRONYMIC = re.compile(r"(ovich|evich|ich|ovna|evna|ichna|ogly|oglu|uly|kyzy|slavov|slavova|ович|евич|ич|овна|евна|ична)$", re.I)


def strip_patronymic(name):
    words = name.split()
    if len(words) >= 3:
        words = [w for i, w in enumerate(words)
                 if not (0 < i < len(words) - 1 and (PATRONYMIC.search(w) or re.fullmatch(r"\w\.", w)))]
    return " ".join(words)


def slugify(title):
    s = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()
    return s or "u" + "_".join(f"{ord(c):x}" for c in title if not c.isspace())


# ---------------------------------------------------------------- teams ----
RANKING_WIDGET = ("{{{{#invoke:Lua|invoke|module=Widget/Factory|fn=fromTemplate|widget=Ratings"
                  "|teamLimit={limit}|progressionLimit=1|storageType=extension}}}}")


def ranked_teams(limit):
    log("Рейтинг команд: https://liquipedia.net/dota2/Portal:Rankings (Liquipedia Rankings, Glicko-2)")
    # Страница показывает топ-20; тот же виджет с большим teamLimit отдаёт больше строк.
    html = lp_parse("Portal:Rankings", RANKING_WIDGET.format(limit=max(limit, 20)))
    upd = re.search(r"Last updated:\s*([0-9-]+)", html)
    if len(re.findall(r'data-ranking-table-cell="team"', html)) < 10:  # запасной вариант
        html = lp_parse("Portal:Rankings")
        upd = re.search(r"Last updated:\s*([0-9-]+)", html)
    teams = []
    for cell in re.findall(r'data-ranking-table-cell="team"[^>]*>(.*?)</td>', html, re.S):
        m = re.search(r'<a href="/dota2/[^"]+" title="([^"]+)"', cell)
        if m and m.group(1) not in teams:
            teams.append(m.group(1).replace("&amp;", "&"))
    src = f"Liquipedia Portal:Rankings, обновлено {upd.group(1) if upd else '?'}"
    if len(teams) < 10:
        raise RuntimeError("Не удалось разобрать таблицу рейтинга Liquipedia")
    log(f"  {src}; команд в таблице: {len(teams)}")
    return teams[:limit], src


def active_roster(text):
    text = re.sub(r"<!--.*?(-->|$)", "", text, flags=re.S)
    # Раздел «Active» (на некоторых страницах — «Active Roster»); у организаций бывает свой
    # «Active» без игроков, поэтому берём первый раздел, где нашлись игроки.
    for header in ("Active", "Active Roster", "Active Squad", "Active Players", "Current Roster", None):
        sec = section(text, header) if header else (section(text, "Player Roster") or text)
        if sec is None:
            continue
        people = squad_players(sec)
        if people:
            return people
    return []


def squad_players(sec):
    squads = [s for s in templates(sec, "Squad")
              if not re.search(r"\|\s*type\s*=\s*(staff|organization|coach)", s, re.I)
              and not re.search(r"\|\s*status\s*=\s*(inactive|former)", s, re.I)]
    people = []
    for sq in squads:
        for p in templates(sq[2:], "Person"):
            pr = params(p)
            if re.search(r"coach|manager|analyst|staff", pr.get("role", "") + pr.get("teamrole", ""), re.I)                     and "loan" not in pr.get("teamrole", "").lower():
                continue
            people.append(pr)
    return people


# --------------------------------------------------------------- photos ----
FREE_RX = re.compile(r"^(cc[- ]?by(-sa)?[- ]?\d|cc0|public domain|pd|cc[- ]?by(-sa)?$)", re.I)


def is_free(lic):
    lic = (lic or "").strip()
    return bool(FREE_RX.search(lic)) and not re.search(r"\bnc\b|\bnd\b|-nc|-nd", lic, re.I)


def words(s):
    return [w for w in re.split(r"[^0-9a-zа-яё]+", s.lower()) if w]


def nick_key(nick):
    return re.sub(r"[^0-9a-zа-яё]", "", nick.lower())


def wikidata_photos(pages):
    """{страница Liquipedia: File:...} по P10918 = dota2/<Страница>."""
    q = """SELECT ?lp ?img WHERE { ?item wdt:P10918 ?lp . FILTER(STRSTARTS(?lp, "dota2/"))
           ?item wdt:P18 ?img . }"""
    try:
        r = WM.get(WD_SPARQL, {"query": q, "format": "json"},
                   headers={"Accept": "application/sparql-results+json"})
    except Exception as e:  # noqa
        log(f"  ! Wikidata недоступна: {e}")
        return {}
    want = {p.replace(" ", "_").lower(): p for p in pages}
    found = {}
    rows = r.json()["results"]["bindings"]
    for b in rows:
        lp = b["lp"]["value"][len("dota2/"):].replace(" ", "_").lower()
        if lp in want:
            fn = requests.utils.unquote(b["img"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
            found[want[lp]] = "File:" + fn
    log(f"  Wikidata: записей dota2 с фото — {len(rows)}, совпало с базой — {len(found)}")
    return found


def commons_info(files):
    """Метаданные, категории и URL уменьшенной копии для файлов Commons."""
    out = {}
    files = list(dict.fromkeys(files))
    for i in range(0, len(files), 50):
        d = WM.get(COMMONS_API, dict(
            action="query", titles="|".join(files[i:i + 50]), prop="imageinfo|categories",
            iiprop="url|extmetadata|mime|size", iiurlwidth=str(PHOTO_WIDTH * 2), cllimit="max",
            clshow="!hidden", format="json", formatversion="2")).json()
        for p in d.get("query", {}).get("pages", []):
            if "imageinfo" not in p:
                continue
            ii = p["imageinfo"][0]
            md = ii.get("extmetadata", {})

            def g(k):
                return clean(re.sub(r"<[^>]+>", "", md.get(k, {}).get("value", "")))
            out[p["title"]] = dict(
                title=p["title"], url=ii.get("thumburl") or ii["url"], page=ii.get("descriptionurl"),
                mime=ii.get("mime", ""), license=g("LicenseShortName"), license_url=g("LicenseUrl"),
                artist=g("Artist") or "неизвестен", desc=g("ImageDescription") + " " + g("ObjectName"),
                cats=[c["title"] for c in p.get("categories", [])])
    return out


PERSON_CAT_SUFFIXES = ("gamer", "esports player", "video game player", "Dota 2 player")
TRUSTED = {}  # файл Commons -> slug игрока (из его персональной категории)


def commons_candidates(player):
    found = []
    nick = player["nick_clean"]
    queries = [f'"{nick}" dota', f'intitle:"{nick}" esports', f'"{nick}" "{player["team"]}"']
    if player["name"]:
        queries.append(f'"{player["name"]}"')
    for q in queries:
        d = WM.get(COMMONS_API, dict(action="query", list="search", srsearch=q, srnamespace="6",
                                     srlimit="20", format="json", formatversion="2")).json()
        found += [x["title"] for x in d.get("query", {}).get("search", [])]
    # Персональная категория игрока («Category:Noone-», «Category:Ame (gamer)»), которая сама
    # входит в «Dota 2 players», — её файлы считаются надёжными (как P18 в Wikidata).
    names = list(dict.fromkeys(n for n in (re.sub(r"[\[\]{}|#<>]", "", player["nickname"]), nick,
                                           re.sub(r"\s*\(.*\)$", "", player["page"])) if n))
    cats = [f"Category:{n}" for n in names] + [f"Category:{n} ({s})" for n in names for s in PERSON_CAT_SUFFIXES]
    d = WM.get(COMMONS_API, dict(action="query", titles="|".join(cats), prop="categoryinfo|categories",
                                 cllimit="max", format="json", formatversion="2")).json()
    for c in d.get("query", {}).get("pages", []):
        if c.get("missing") or not c.get("categoryinfo", {}).get("files"):
            continue
        parents = " ".join(x["title"] for x in c.get("categories", [])).lower()
        if "dota 2 players" not in parents:
            continue
        m = WM.get(COMMONS_API, dict(action="query", list="categorymembers", cmtitle=c["title"],
                                     cmtype="file", cmlimit="30", format="json", formatversion="2")).json()
        for x in m.get("query", {}).get("categorymembers", []):
            TRUSTED[x["title"]] = player["slug"]
            found.insert(0, x["title"])
    return found


def commons_accept(player, info):
    """Принять файл: ник — отдельным словом в имени файла И явная связь с игроком."""
    if info["title"] in BLOCKED_FILES or not info["mime"].startswith("image/"):
        return False
    if info["mime"] in ("image/svg+xml", "image/gif"):
        return False
    nk = nick_key(player["nick_clean"])
    blob = " ".join([info["title"], info["desc"], " ".join(info["cats"])]).lower()
    cats = " ".join(info["cats"]).lower()
    if not nk or nk not in [nick_key(w) for w in words(info["title"][5:].rsplit(".", 1)[0])]:
        return False
    if re.search(re.escape(player["nick_clean"].lower()) + r" \((gamer|esports player|video game player|dota 2 player)\)", cats):
        return True
    name = player["name"].lower()
    if name and len(name.split()) >= 2 and name in blob:
        return True
    if player["team"].lower() in blob:
        return True
    return "dota" in blob


def save_photo(url, dest):
    save_photo_bytes(WM.get(url).content, dest)


def save_photo_bytes(data, dest):
    if Image is not None:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im).convert("RGB")
        if im.width > PHOTO_WIDTH:
            im = im.resize((PHOTO_WIDTH, round(im.height * PHOTO_WIDTH / im.width)), Image.LANCZOS)
        im.save(dest, "JPEG", quality=84, optimize=True, progressive=True)
    else:
        dest.write_bytes(data)


def liquipedia_photos(players, db):
    """Фото из инфобоксов игроков на Liquipedia (основной источник). Лицензия там обычно
    «permission», поэтому в CREDITS.md пишем автора и ссылку на страницу файла."""
    want = {}
    for p in players:
        img = p.get("lp_image")
        if not img:
            continue
        title = "File:" + img
        if title in BLOCKED_FILES:
            continue
        cur = db.get(p["slug"])
        if cur and cur.get("via") == "Liquipedia" and cur.get("file_title") == title                 and (IMG_DIR / cur["file"]).exists():
            continue
        want[p["slug"]] = (p, title)
    log(f"Фото Liquipedia: в инфобоксах {sum(1 for p in players if p.get('lp_image'))}, "
        f"скачать {len(want)}")
    titles = list(dict.fromkeys(t for _, t in want.values()))
    info = {}
    for i in range(0, len(titles), 50):
        d = lp_query(action="query", titles="|".join(titles[i:i + 50]), prop="imageinfo",
                     iiprop="url|extmetadata|mime", iiurlwidth=str(PHOTO_WIDTH * 2))
        q = d.get("query", {})
        norm = {x["to"]: x["from"] for x in q.get("normalized", [])}
        for pg in q.get("pages", []):
            if pg.get("imageinfo"):
                ii = pg["imageinfo"][0]
                md = ii.get("extmetadata", {})
                info[norm.get(pg["title"], pg["title"])] = dict(
                    url=ii.get("thumburl") or ii["url"], page=ii.get("descriptionurl", ""),
                    mime=ii.get("mime", ""),
                    artist=clean(re.sub(r"<[^>]+>", "", md.get("Artist", {}).get("value", ""))),
                    license=clean(re.sub(r"<[^>]+>", "", md.get("LicenseShortName", {}).get("value", ""))))
    for slug, (p, title) in want.items():
        inf = info.get(title)
        if not inf or not inf["mime"].startswith("image/") or inf["mime"] == "image/svg+xml":
            log(f"  ! {p['nickname']}: нет файла {title} на Liquipedia")
            continue
        fname = slug + ".jpg"
        try:
            url = inf["url"] if inf["url"].startswith("http") else "https://liquipedia.net" + inf["url"]
            save_photo_bytes(LP.get(url).content, IMG_DIR / fname)
        except Exception as e:  # noqa
            log(f"  ! {p['nickname']}: не скачалось {title}: {e}")
            continue
        db[slug] = dict(file=fname, file_title=title, nickname=p["nickname"], page=inf["page"],
                        author=inf["artist"] or "Liquipedia", license=inf["license"] or "Liquipedia (permission)",
                        license_url="", via="Liquipedia")
        log(f"  + {p['nickname']}: {title}")


def update_photos(players):
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    db = json.loads(PHOTOS_DB.read_text("utf-8")) if PHOTOS_DB.exists() else {}
    # записи, которые попали в блок-лист, выкидываем
    db = {k: v for k, v in db.items() if v.get("file_title") not in BLOCKED_FILES}

    liquipedia_photos(players, db)
    need = [p for p in players if p["slug"] not in db or not (IMG_DIR / db[p["slug"]]["file"]).exists()]
    log(f"Фото: уже есть {len(players) - len(need)}, ищем для {len(need)}")
    if need:
        wd = wikidata_photos([p["page"] for p in need])
        chosen = {}
        for p in need:
            if p["page"] in wd:
                chosen[p["slug"]] = [wd[p["page"]]]
        for n, p in enumerate(need, 1):
            if p["slug"] in chosen:
                continue
            chosen[p["slug"]] = commons_candidates(p)
            if n % 20 == 0:
                log(f"  Commons: просмотрено {n}/{len(need)}")
        info = commons_info([f for lst in chosen.values() for f in lst])
        for p in need:
            from_wd = p["page"] in wd
            for f in chosen.get(p["slug"], []):
                inf = info.get(f)
                if not inf or f in BLOCKED_FILES:
                    continue
                trusted = from_wd or TRUSTED.get(f) == p["slug"]
                if not trusted and not commons_accept(p, inf):
                    continue
                if not is_free(inf["license"]):
                    log(f"  - {p['nickname']}: {f} — лицензия «{inf['license']}» не свободная")
                    continue
                fname = p["slug"] + ".jpg"
                try:
                    save_photo(inf["url"], IMG_DIR / fname)
                except Exception as e:  # noqa
                    log(f"  ! {p['nickname']}: не скачалось {f}: {e}")
                    continue
                db[p["slug"]] = dict(file=fname, file_title=f, nickname=p["nickname"], page=inf["page"],
                                     author=inf["artist"], license=inf["license"],
                                     license_url=inf["license_url"],
                                     via="Wikidata P18" if from_wd else
                                     "категория Commons" if TRUSTED.get(f) == p["slug"] else "поиск Commons")
                log(f"  + {p['nickname']}: {f} ({inf['license']})")
                break

    # удалить ненужные
    keep = {p["slug"] for p in players}
    db = {k: v for k, v in db.items() if k in keep}
    files = {v["file"] for v in db.values()}
    for f in IMG_DIR.glob("*"):
        if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp") and f.name not in files:
            log(f"  удалено лишнее фото: {f.name}")
            f.unlink()
    PHOTOS_DB.write_text(json.dumps(db, ensure_ascii=False, indent=1, sort_keys=True), "utf-8")

    lines = ["# Фото игроков — авторы и лицензии", "",
             "Фото игроков взяты с Liquipedia (liquipedia.net, лицензия «с разрешения» — права у авторов) "
             "и с Wikimedia Commons (свободные лицензии), уменьшены и пережаты в JPEG. "
             "Некоммерческий фан-проект; по просьбе автора фото будет удалено.", "",
             "| Игрок | Файл | Автор | Лицензия |", "|---|---|---|---|"]
    for k, v in sorted(db.items(), key=lambda kv: kv[1]["nickname"].lower()):
        lic = f"[{v['license']}]({v['license_url']})" if v.get("license_url") else v["license"]
        author = v["author"].replace("|", "/").replace("\n", " ")
        link = f"[{v['file_title'][5:]}]({v['page']})" if v.get("page") else v["file_title"][5:]
        lines.append(f"| {v['nickname']} | {link} | {author} | {lic} |")
    CREDITS_MD.write_text("\n".join(lines) + "\n", "utf-8")
    return {k: "img/players/" + v["file"] for k, v in db.items()}


# ----------------------------------------------------------------- main ----
def load_legends(current, bad_country):
    """Бывшие игроки первого эшелона и стримеры из tools/legends.json (данные — с Liquipedia)."""
    if not LEGENDS.exists():
        return []
    legends = {k: v for k, v in json.loads(LEGENDS.read_text("utf-8")).items() if not k.startswith("_")}
    log(f"Легенды и стримеры: {len(legends)} страниц из {LEGENDS.relative_to(ROOT)}")
    texts = lp_wikitext(list(legends))
    have = {p["page"] for p in current}
    out = []
    for page, cfg in legends.items():
        final, text = texts[page]
        if not text:
            log(f"  ! нет страницы {page}")
            continue
        if final in have:
            log(f"  {page}: уже в действующих составах — пропускаем")
            continue
        box = (templates(text, "Infobox player") or [""])[0]
        bp = params(box) if box else {}
        nick = clean(bp.get("id", "")) or final
        code = clean(bp.get("country", "")).lower()
        code = COUNTRY_NAMES.get(code, code)
        country = COUNTRIES.get(code)
        if not country:
            bad_country.append(f"{nick}: «{code}»")
            country = code.upper() or "—"
        name = clean(bp.get("romanized_name") or bp.get("name", ""))
        have.add(final)
        out.append(dict(slug=slugify(final), page=final, nickname=nick,
                        nick_clean=re.sub(r"[^\w.]+", "", nick) or nick, name=strip_patronymic(name),
                        team=cfg.get("team") or "Вне команды", country=country,
                        role=int(cfg["role"]), rating=max(0, min(99, int(cfg["rating"]))),
                        tag=cfg.get("tag", "Легенда"), lp_image=clean(bp.get("image", ""))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--teams", type=int, default=25)
    ap.add_argument("--min-roster", type=int, default=3)
    ap.add_argument("--no-photos", action="store_true")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    ratings = json.loads(RATINGS.read_text("utf-8")) if RATINGS.exists() else {}
    roles = json.loads(ROLES.read_text("utf-8")) if ROLES.exists() else {}
    ratings = {k: v for k, v in ratings.items() if not k.startswith("_")}
    roles = {k: v for k, v in roles.items() if not k.startswith("_")}

    teams, source = ranked_teams(args.teams)
    for i, t in enumerate(teams, 1):
        log(f"  {i:2}. {t}")
    log(f"Список команд взят отсюда: {source} — {LP_WIKI}Portal:Rankings")

    log("Составы команд (раздел «Active»)…")
    pages = lp_wikitext(teams)
    raw = []
    for t in teams:
        final, text = pages[t]
        if not text:
            log(f"  ! нет страницы команды {t}")
            continue
        roster = active_roster(text)
        if len(roster) < args.min_roster:
            log(f"  {final}: активный состав {len(roster)} чел. — пропускаем (распад/перестройка)")
            continue
        log(f"  {final}: {', '.join(clean(p.get('id', '?')) for p in roster)}")
        for pr in roster:
            nick = clean(pr.get("id", ""))
            if not nick:
                continue
            raw.append(dict(nickname=nick, page=clean(pr.get("link", "")) or nick, team=final,
                            flag=clean(pr.get("flag", "")).lower(), name=clean(pr.get("name", "")),
                            role=role_from(pr.get("position", "")),
                            joined=re.sub(r"<ref.*", "", pr.get("joindate", "")).strip()))

    log("Страницы игроков (инфобоксы)…")
    ptexts = lp_wikitext([r["page"] for r in raw])
    # Игрок может числиться в двух составах (устаревшая страница команды) —
    # оставляем команду с более поздней датой вступления.
    latest = {}
    for r in raw:
        final = ptexts.get(r["page"], (r["page"], None))[0]
        if final not in latest or r["joined"] > latest[final]["joined"]:
            latest[final] = r
    for final, r in latest.items():
        dups = [x["team"] for x in raw if x is not r and ptexts.get(x["page"], (x["page"],))[0] == final]
        if dups:
            log(f"  {r['nickname']}: числится также в {', '.join(dups)} — берём {r['team']}")
    raw = [r for r in raw if latest[ptexts.get(r["page"], (r["page"],))[0]] is r]
    players, seen = [], set()
    no_rating, no_role, bad_country = [], [], []
    for r in raw:
        final, text = ptexts.get(r["page"], (r["page"], None))
        r["page"] = final
        if final in seen:
            continue
        seen.add(final)
        if text:
            box = (templates(text, "Infobox player") or [""])[0]
            bp = params(box) if box else {}
            if not r["name"]:
                r["name"] = clean(bp.get("romanized_name") or bp.get("name", ""))
            if not r["flag"]:
                r["flag"] = clean(bp.get("country", "")).lower()
            r["lp_image"] = clean(bp.get("image", ""))
            if r["role"] is None:
                for key in ("position", "roles", "role", "role2"):
                    if bp.get(key):
                        r["role"] = role_from(bp[key])
                        if r["role"]:
                            break
        nick = r["nickname"]
        if nick in roles:
            r["role"] = int(roles[nick])
        if r["role"] is None:
            no_role.append(f"{nick} ({r['team']})")
            continue
        country = COUNTRIES.get(r["flag"])
        if not country:
            bad_country.append(f"{nick}: «{r['flag']}»")
            country = r["flag"].upper() or "—"
        if nick in ratings:
            rating = int(ratings[nick])
        else:
            rating = DEFAULT_RATING
            no_rating.append(f"{nick} ({r['team']})")
        players.append(dict(slug=slugify(final), page=final, nickname=nick,
                            nick_clean=re.sub(r"[^\w.]+", "", nick) or nick,
                            name=strip_patronymic(r["name"]), team=r["team"], country=country,
                            role=r["role"], rating=max(0, min(99, rating)), lp_image=r.get("lp_image", "")))

    transfers = json.loads(TRANSFERS.read_text("utf-8")) if TRANSFERS.exists() else {}
    for p in players:
        new_team = transfers.get(p["nickname"])
        if not new_team:
            continue
        if new_team == p["team"]:
            log(f"  {p['nickname']}: на Liquipedia уже {new_team} — строку в transfers.json можно удалить")
        else:
            log(f"  Переход вручную: {p['nickname']} {p['team']} → {new_team}")
            p["team"] = new_team
    missing = sorted(set(k for k in transfers if not k.startswith("_")) - {p["nickname"] for p in players})
    if missing:
        log(f"  ! В transfers.json игроки не из базы: {', '.join(missing)}")

    players += load_legends(players, bad_country)

    photos = {} if args.no_photos else update_photos(players)
    if args.no_photos and PHOTOS_DB.exists():
        db = json.loads(PHOTOS_DB.read_text("utf-8"))
        photos = {k: "img/players/" + v["file"] for k, v in db.items() if (IMG_DIR / v["file"]).exists()}

    out = []
    for p in sorted(players, key=lambda x: (-x["rating"], x["nickname"].lower())):
        row = dict(id=p["slug"], nickname=p["nickname"], name=p["name"], team=p["team"],
                   country=p["country"], role=p["role"], rating=p["rating"],
                   photo=photos.get(p["slug"]))
        if p.get("tag"):
            row["tag"] = p["tag"]   # «Легенда» / «Стример» — в игре это отдельная группа
        out.append(row)
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps({"updated": time.strftime("%Y-%m-%d"), "source": source,
                                "players": out}, ensure_ascii=False, indent=1), "utf-8")

    log("")
    log(f"Итого игроков: {len(out)}, с фото: {sum(1 for p in out if p['photo'])} → {DATA.relative_to(ROOT)}")
    for title, group in (("Позиции (действующие):", [p for p in out if not p.get("tag")]),
                         ("Позиции (легенды и стримеры):", [p for p in out if p.get("tag")])):
        log(title)
        for pos in range(1, 6):
            row = [p for p in group if p["role"] == pos]
            tiers = " ".join(f"{t}+:{sum(1 for p in row if p['rating'] >= t)}" for t in (90, 80, 70))
            log(f"  Pos {pos} ({POS_NAMES[pos]}): {len(row)}  [{tiers}]")
    log(f"Без рейтинга (поставлено {DEFAULT_RATING}): {', '.join(no_rating) or 'нет'}")
    log(f"Без позиции (пропущены): {', '.join(no_role) or 'нет'}")
    log(f"Неизвестные страны: {', '.join(bad_country) or 'нет'}")
    unused = sorted(set(ratings) - {p["nickname"] for p in out})
    if unused:
        log(f"Лишние ключи в ratings.json: {', '.join(unused)}")


if __name__ == "__main__":
    main()
