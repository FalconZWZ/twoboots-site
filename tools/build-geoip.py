#!/usr/bin/env python3
"""Builds data/geoip-v4.bin.gz — the IP → region table the visitor counter uses.

Source: DB-IP «IP to City Lite» (https://db-ip.com, CC BY 4.0, "IP Geolocation by DB-IP").
Russia is kept by region (names in Russian), other countries by country code; IPv4 only.

    curl -O https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.csv.gz
    python3 tools/build-geoip.py dbip-city-lite-YYYY-MM.csv.gz

File layout: uint32 LE header length, header JSON {"labels": [...], "source": ...}, then
n uint32 LE range starts (sorted) and n uint16 LE label indexes; label 0 is "unknown".
"""
import csv, gzip, ipaddress, json, struct, sys

# DB-IP spells many regions in several ways; all map to the subject's Russian name
RU_REGIONS = {
    'Adygeya Republic': 'Адыгея', 'Altai': 'Республика Алтай', 'Altay Kray': 'Алтайский край', 'Amur Oblast': 'Амурская область',
    'Arkhangelsk Oblast': 'Архангельская область', 'Arkhangelskaya': 'Архангельская область', 'Astrakhan': 'Астраханская область',
    'Astrakhan Oblast': 'Астраханская область', 'Bashkortostan Republic': 'Башкортостан', 'Belgorod Oblast': 'Белгородская область',
    'Bryansk Oblast': 'Брянская область', 'Buryatiya Republic': 'Бурятия', 'Chechnya': 'Чечня', 'Chelyabinsk': 'Челябинская область',
    'Chukotka': 'Чукотский АО', 'Chuvash Republic': 'Чувашия', 'Chuvashia': 'Чувашия', 'Crimea': 'Крым', 'Dagestan': 'Дагестан',
    'Ingushetiya Republic': 'Ингушетия', 'Irkutsk Oblast': 'Иркутская область', 'Ivanovo': 'Ивановская область',
    'Ivanovo Oblast': 'Ивановская область', 'Jaroslavl': 'Ярославская область', 'Jewish Autonomous Oblast': 'Еврейская АО',
    'Kabardino-Balkariya Republic': 'Кабардино-Балкария', 'Kaliningrad': 'Калининградская область',
    'Kaliningrad Oblast': 'Калининградская область', 'Kalmykiya Republic': 'Калмыкия', 'Kaluga': 'Калужская область',
    'Kaluga Oblast': 'Калужская область', 'Kamchatka': 'Камчатский край', 'Karachayevo-Cherkesiya Republic': 'Карачаево-Черкесия',
    'Karelia': 'Карелия', 'Kemerovo Oblast': 'Кемеровская область', 'Kuzbass': 'Кемеровская область', 'Khabarovsk': 'Хабаровский край',
    'Khakasiya Republic': 'Хакасия', 'Khanty-Mansia': 'Ханты-Мансийский АО', 'Kirov': 'Кировская область', 'Kirov Oblast': 'Кировская область',
    'Komi': 'Коми', 'Kostroma Oblast': 'Костромская область', 'Krasnodar Krai': 'Краснодарский край', 'Krasnodarskiy': 'Краснодарский край',
    'Krasnoyarsk Krai': 'Красноярский край', 'Krasnoyarskiy': 'Красноярский край', 'Kurgan Oblast': 'Курганская область',
    'Kursk': 'Курская область', 'Kursk Oblast': 'Курская область', "Leningradskaya Oblast'": 'Ленинградская область',
    'Lipetsk Oblast': 'Липецкая область', 'Magadan Oblast': 'Магаданская область', 'Mariy-El Republic': 'Марий Эл',
    'Mordoviya Republic': 'Мордовия', 'Moscow': 'Москва', 'Moscow Oblast': 'Московская область', 'Murmansk': 'Мурманская область',
    'Nenets': 'Ненецкий АО', 'Nizhny Novgorod Oblast': 'Нижегородская область', 'North Ossetia': 'Северная Осетия',
    'North Ossetia–Alania': 'Северная Осетия', 'Novgorod Oblast': 'Новгородская область', 'Novosibirsk Oblast': 'Новосибирская область',
    'Omsk': 'Омская область', 'Omsk Oblast': 'Омская область', 'Orel Oblast': 'Орловская область', 'Oryol oblast': 'Орловская область',
    'Orenburg Oblast': 'Оренбургская область', 'Penza': 'Пензенская область', 'Penza Oblast': 'Пензенская область',
    'Perm': 'Пермский край', 'Perm Krai': 'Пермский край', 'Primorskiy (Maritime) Kray': 'Приморский край', 'Primorye': 'Приморский край',
    'Pskov Oblast': 'Псковская область', 'Rostov': 'Ростовская область', 'Ryazan Oblast': 'Рязанская область', 'Sakha': 'Якутия',
    'Sakhalin Oblast': 'Сахалинская область', 'Samara Oblast': 'Самарская область', 'Saratov Oblast': 'Саратовская область',
    'Saratovskaya Oblast': 'Саратовская область', 'Sebastopol City': 'Севастополь', 'Smolensk': 'Смоленская область',
    'Smolensk Oblast': 'Смоленская область', 'Smolenskaya Oblast’': 'Смоленская область', 'St.-Petersburg': 'Санкт-Петербург',
    'Stavropol Krai': 'Ставропольский край', 'Stavropol Kray': 'Ставропольский край', 'Stavropol’ Kray': 'Ставропольский край',
    'Sverdlovsk': 'Свердловская область', 'Sverdlovsk Oblast': 'Свердловская область', 'Tambov': 'Тамбовская область',
    'Tambov Oblast': 'Тамбовская область', 'Tatarstan Republic': 'Татарстан', 'Tomsk Oblast': 'Томская область',
    'Transbaikal Territory': 'Забайкальский край', 'Zabaykalskiy (Transbaikal) Kray': 'Забайкальский край', 'Tula': 'Тульская область',
    'Tula Oblast': 'Тульская область', 'Tver Oblast': 'Тверская область', 'Tver’ Oblast': 'Тверская область',
    'Tyumen Oblast': 'Тюменская область', 'Tyumen’ Oblast': 'Тюменская область', 'Tyva Republic': 'Тыва',
    'Udmurtiya Republic': 'Удмуртия', 'Ulyanovsk': 'Ульяновская область', 'Vladimir': 'Владимирская область',
    'Vladimir Oblast': 'Владимирская область', 'Volgograd Oblast': 'Волгоградская область', 'Vologda': 'Вологодская область',
    'Vologda Oblast': 'Вологодская область', 'Voronezh Oblast': 'Воронежская область', 'Voronezj': 'Воронежская область',
    'Yamalo-Nenets': 'Ямало-Ненецкий АО', 'Yaroslavl Oblast': 'Ярославская область',
}

def label_of(country, region):
    if country == 'RU':
        return 'RU:' + RU_REGIONS.get(region, 'другой регион') if region else 'RU:'
    return country or ''

def main(src, dst='data/geoip-v4.bin.gz'):
    labels, index = [''], {'': 0}
    starts, ids = [], []
    prev_end = -1
    with gzip.open(src, 'rt', encoding='utf-8') as f:
        for row in csv.reader(f):
            if ':' in row[0]:
                continue
            num = lambda v: int(v) if v.isdigit() else int(ipaddress.ip_address(v))
            s, e = num(row[0]), num(row[1])
            # an already-reduced file has the country in column 3, the full DB-IP file in column 4
            country, region = (row[2], row[3]) if len(row) == 4 else (row[3], row[4])
            lab = label_of(country, region)
            i = index.setdefault(lab, len(labels))
            if i == len(labels):
                labels.append(lab)
            if s > prev_end + 1:              # a gap: addresses nobody is known to use
                if ids and ids[-1] != 0:
                    starts.append(prev_end + 1); ids.append(0)
            if ids and ids[-1] == i and s <= prev_end + 1:
                prev_end = max(prev_end, e); continue
            starts.append(s); ids.append(i); prev_end = e
    header = json.dumps({'labels': labels, 'source': 'IP Geolocation by DB-IP (db-ip.com), CC BY 4.0'}, ensure_ascii=False).encode()
    body = struct.pack('<I', len(header)) + header + struct.pack(f'<{len(starts)}I', *starts) + struct.pack(f'<{len(ids)}H', *ids)
    with gzip.open(dst, 'wb', compresslevel=9) as out:
        out.write(body)
    print(f'{len(starts)} ranges, {len(labels)} labels → {dst}')

if __name__ == '__main__':
    main(*sys.argv[1:])
