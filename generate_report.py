import json
import os
import numpy as np
from collections import Counter, defaultdict
from datetime import datetime, date

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import matplotlib.patches as mpatches
import matplotlib.ticker as mticker

# Optional: seaborn for nicer styles
try:
    import seaborn as sns
    sns.set_theme(style="whitegrid", font_scale=0.9)
    HAS_SNS = True
except ImportError:
    HAS_SNS = False

# ── Load data ──────────────────────────────────────────────────────────────
DATA_FILE = os.path.join(os.path.dirname(__file__), "CRM_DATA.json")
with open(DATA_FILE, "r", encoding="utf-8") as f:
    raw = json.load(f)

customers = raw["customers"] if isinstance(raw, dict) else raw
TOTAL = len(customers)

# ── Swedish zip → county mapping (first two digits) ──────────────────────
ZIP_TO_COUNTY = {
    "10": "Stockholm", "11": "Stockholm", "12": "Stockholm", "13": "Stockholm",
    "14": "Stockholm", "15": "Stockholm", "16": "Stockholm", "17": "Stockholm",
    "18": "Stockholm", "19": "Stockholm",
    "20": "Malmö/Skåne", "21": "Malmö/Skåne", "22": "Lund/Skåne", "23": "Skåne",
    "24": "Skåne", "25": "Helsingborg/Skåne", "26": "Skåne", "27": "Skåne",
    "28": "Skåne", "29": "Skåne",
    "30": "Halland", "31": "Halland",
    "32": "Halland",
    "33": "Västra Götaland", "34": "Västra Götaland",
    "35": "Kronoberg", "36": "Kronoberg",
    "37": "Blekinge",
    "38": "Kalmar", "39": "Kalmar",
    "40": "Göteborg/V.Götaland", "41": "Göteborg/V.Götaland",
    "42": "Göteborg/V.Götaland", "43": "Göteborg/V.Götaland",
    "44": "Göteborg/V.Götaland", "45": "Västra Götaland",
    "46": "Västra Götaland", "47": "Västra Götaland",
    "50": "Västra Götaland", "51": "Västra Götaland", "52": "Västra Götaland",
    "53": "Västra Götaland", "54": "Västra Götaland",
    "55": "Jönköping", "56": "Jönköping",
    "57": "Östergötland", "58": "Östergötland", "59": "Östergötland",
    "60": "Östergötland", "61": "Östergötland",
    "62": "Gotland",
    "63": "Sörmland", "64": "Sörmland",
    "65": "Värmland", "66": "Värmland",
    "67": "Värmland", "68": "Värmland", "69": "Värmland",
    "70": "Örebro", "71": "Örebro",
    "72": "Västmanland", "73": "Västmanland",
    "74": "Uppsala", "75": "Uppsala",
    "76": "Uppsala",
    "77": "Dalarna", "78": "Dalarna", "79": "Dalarna",
    "80": "Gävleborg", "81": "Gävleborg", "82": "Gävleborg",
    "83": "Västernorrland", "84": "Västernorrland",
    "85": "Västernorrland", "86": "Västerbotten",
    "87": "Västerbotten", "88": "Västerbotten",
    "89": "Norrbotten",
    "90": "Norrbotten", "91": "Norrbotten",
    "92": "Norrbotten", "93": "Norrbotten",
    "94": "Norrbotten", "95": "Norrbotten", "96": "Norrbotten",
    "97": "Norrbotten", "98": "Norrbotten",
}

# Approximate county centroids (lat, lon) for map plotting
COUNTY_COORDS = {
    "Stockholm":            (59.33, 18.07),
    "Malmö/Skåne":          (55.60, 13.00),
    "Lund/Skåne":           (55.70, 13.19),
    "Skåne":                (55.85, 13.60),
    "Helsingborg/Skåne":    (56.05, 12.70),
    "Halland":              (56.87, 12.85),
    "Västra Götaland":      (58.25, 12.80),
    "Göteborg/V.Götaland":  (57.70, 11.97),
    "Kronoberg":            (56.88, 14.80),
    "Blekinge":             (56.17, 15.58),
    "Kalmar":               (56.66, 16.36),
    "Jönköping":            (57.78, 14.16),
    "Östergötland":         (58.41, 15.62),
    "Gotland":              (57.63, 18.30),
    "Sörmland":             (59.05, 16.75),
    "Värmland":             (59.70, 13.40),
    "Örebro":               (59.27, 15.21),
    "Västmanland":          (59.62, 16.55),
    "Uppsala":              (59.86, 17.64),
    "Dalarna":              (61.00, 14.50),
    "Gävleborg":            (60.67, 17.00),
    "Västernorrland":       (62.63, 17.93),
    "Västerbotten":         (64.75, 18.00),
    "Norrbotten":           (66.50, 20.20),
}

# ── Helper functions ──────────────────────────────────────────────────────

def get_county(c):
    zc = (c.get("zip_code") or "").replace(" ", "").strip()
    if len(zc) >= 2:
        return ZIP_TO_COUNTY.get(zc[:2], "Unknown")
    return "Unknown"

def parse_age(c):
    dob = c.get("date_of_birth")
    if not dob:
        return None
    try:
        born = datetime.strptime(dob, "%Y-%m-%d").date()
        today = date.today()
        return today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    except Exception:
        return None

def parse_gender(c):
    """Swedish PIN: second-to-last digit odd=male, even=female."""
    pin = (c.get("pin") or "").replace("-", "").replace(" ", "")
    if len(pin) >= 10:
        d = pin[-2]
        if d.isdigit():
            return "Male" if int(d) % 2 == 1 else "Female"
    return "Unknown"

def safe_sales(c):
    v = c.get("total_sales")
    try:
        return float(v) if v is not None else 0.0
    except (ValueError, TypeError):
        return 0.0

# ── Pre-compute fields ───────────────────────────────────────────────────
for c in customers:
    c["_county"] = get_county(c)
    c["_age"] = parse_age(c)
    c["_gender"] = parse_gender(c)
    c["_sales"] = safe_sales(c)
    c["_visits"] = int(c.get("visits") or 0)
    c["_has_iban"] = bool(c.get("iban_number"))
    c["_marketing"] = bool(c.get("marketing_opt_in"))

sales_arr = np.array([c["_sales"] for c in customers])
ages = [c["_age"] for c in customers if c["_age"] is not None]
ages_arr = np.array(ages) if ages else np.array([])

# ── Color palette ─────────────────────────────────────────────────────────
GOLD = "#C8A951"
DARK = "#1C1C1E"
ACCENT = "#3A86FF"
ACCENT2 = "#FF6B6B"
BG = "#FAFAFA"
GRID_C = "#E0E0E0"

def style_ax(ax, title=""):
    ax.set_facecolor("white")
    ax.set_title(title, fontsize=11, fontweight="bold", pad=8)
    ax.tick_params(labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(GRID_C)

# ── Generate PDF ──────────────────────────────────────────────────────────
OUT = os.path.join(os.path.dirname(__file__), "CRM_REPORT.pdf")

with PdfPages(OUT) as pdf:
    # ════════════════════════════════════════════════════════════════════
    # PAGE 1 – Title & KPI Cards
    # ════════════════════════════════════════════════════════════════════
    fig = plt.figure(figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)

    fig.text(0.5, 0.88, "Gold Adam CRM – Full Statistical Report",
             ha="center", fontsize=22, fontweight="bold", color=DARK)
    fig.text(0.5, 0.83, f"Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}   •   {TOTAL:,} customers",
             ha="center", fontsize=11, color="gray")

    total_rev = sales_arr.sum()
    avg_sale = sales_arr.mean()
    median_sale = np.median(sales_arr)
    max_sale = sales_arr.max()
    avg_visits = np.mean([c["_visits"] for c in customers])
    pct_marketing = sum(1 for c in customers if c["_marketing"]) / TOTAL * 100
    pct_iban = sum(1 for c in customers if c["_has_iban"]) / TOTAL * 100
    avg_age = ages_arr.mean() if len(ages_arr) else 0

    kpis = [
        ("Total Customers", f"{TOTAL:,}"),
        ("Total Revenue", f"{total_rev:,.0f} SEK"),
        ("Avg Sale / Customer", f"{avg_sale:,.0f} SEK"),
        ("Median Sale", f"{median_sale:,.0f} SEK"),
        ("Max Sale", f"{max_sale:,.0f} SEK"),
        ("Avg Visits", f"{avg_visits:.1f}"),
        ("Marketing Opt-in", f"{pct_marketing:.1f}%"),
        ("Has IBAN", f"{pct_iban:.1f}%"),
        ("Avg Age", f"{avg_age:.1f} yrs"),
        ("Unique Cities", f"{len(set(c.get('city','').strip() for c in customers if c.get('city')))}"),
    ]

    cols, rows = 5, 2
    for idx, (label, value) in enumerate(kpis):
        row, col = divmod(idx, cols)
        x = 0.08 + col * 0.18
        y = 0.55 - row * 0.22
        rect = plt.Rectangle((x - 0.01, y - 0.04), 0.16, 0.16,
                              transform=fig.transFigure, facecolor="white",
                              edgecolor=GOLD, linewidth=1.5, clip_on=False,
                              zorder=5, alpha=0.95)
        fig.patches.append(rect)
        fig.text(x + 0.07, y + 0.07, value, ha="center", va="center",
                 fontsize=13, fontweight="bold", color=DARK)
        fig.text(x + 0.07, y + 0.01, label, ha="center", va="center",
                 fontsize=8, color="gray")

    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 2 – Sweden Heatmap + Regional Table
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(1, 2, figsize=(14, 8.5), gridspec_kw={"width_ratios": [1.3, 1]})
    fig.patch.set_facecolor(BG)
    fig.suptitle("Geographic Distribution – Sales Heatmap of Sweden", fontsize=15, fontweight="bold", y=0.97)

    ax_map = axes[0]
    ax_tbl = axes[1]

    # Aggregate by county
    county_sales = defaultdict(float)
    county_count = defaultdict(int)
    for c in customers:
        county_sales[c["_county"]] += c["_sales"]
        county_count[c["_county"]] += 1

    # Remove unknown
    county_sales.pop("Unknown", None)
    county_count.pop("Unknown", None)

    counties = sorted(county_sales.keys(), key=lambda k: county_sales[k], reverse=True)
    sales_vals = [county_sales[cn] for cn in counties]
    max_s = max(sales_vals) if sales_vals else 1

    # Draw Sweden outline (simplified)
    ax_map.set_xlim(10, 25)
    ax_map.set_ylim(55, 70)
    ax_map.set_aspect(1.8)
    ax_map.set_facecolor("#E8F4FD")
    style_ax(ax_map, "Total Sales by Region")
    ax_map.set_xlabel("Longitude", fontsize=8)
    ax_map.set_ylabel("Latitude", fontsize=8)

    cmap = plt.cm.YlOrRd
    for cn in counties:
        if cn not in COUNTY_COORDS:
            continue
        lat, lon = COUNTY_COORDS[cn]
        intensity = county_sales[cn] / max_s
        color = cmap(0.2 + 0.8 * intensity)
        size = 80 + 600 * intensity
        ax_map.scatter(lon, lat, s=size, c=[color], edgecolors="white",
                       linewidths=0.8, zorder=3, alpha=0.85)
        if intensity > 0.15:
            ax_map.annotate(cn.split("/")[0], (lon, lat), fontsize=5.5,
                            ha="center", va="bottom", color=DARK,
                            xytext=(0, 6), textcoords="offset points")

    # Colorbar
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(0, max_s))
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax_map, fraction=0.03, pad=0.04)
    cbar.set_label("Total Sales (SEK)", fontsize=8)
    cbar.ax.tick_params(labelsize=7)

    # Table
    ax_tbl.axis("off")
    style_ax(ax_tbl, "Regional Breakdown")

    table_data = []
    for cn in counties[:20]:
        table_data.append([
            cn,
            f"{county_count[cn]:,}",
            f"{county_sales[cn]:,.0f}",
            f"{county_sales[cn]/county_count[cn]:,.0f}" if county_count[cn] else "0",
        ])

    tbl = ax_tbl.table(cellText=table_data,
                       colLabels=["Region", "Customers", "Total Sales (SEK)", "Avg Sales"],
                       loc="upper center", cellLoc="center")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(7)
    tbl.scale(1.0, 1.25)
    for (r, c_), cell in tbl.get_celld().items():
        if r == 0:
            cell.set_facecolor(GOLD)
            cell.set_text_props(color="white", fontweight="bold")
        else:
            cell.set_facecolor("white" if r % 2 == 0 else "#F7F7F7")
        cell.set_edgecolor(GRID_C)

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 3 – Sales Distribution Analysis
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(2, 2, figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)
    fig.suptitle("Sales Distribution Analysis", fontsize=15, fontweight="bold", y=0.97)

    # 3a – Histogram
    ax = axes[0, 0]
    style_ax(ax, "Sales Distribution (Histogram)")
    ax.hist(sales_arr[sales_arr > 0], bins=50, color=ACCENT, alpha=0.7, edgecolor="white")
    ax.axvline(avg_sale, color=ACCENT2, linestyle="--", linewidth=1.2, label=f"Mean: {avg_sale:,.0f}")
    ax.axvline(median_sale, color=GOLD, linestyle="--", linewidth=1.2, label=f"Median: {median_sale:,.0f}")
    ax.legend(fontsize=7)
    ax.set_xlabel("Total Sales (SEK)", fontsize=8)
    ax.set_ylabel("Frequency", fontsize=8)

    # 3b – Sales brackets
    ax = axes[0, 1]
    style_ax(ax, "Customer Segments by Sales Bracket")
    brackets = [
        ("0 SEK", 0, 0),
        ("1–1,000", 1, 1000),
        ("1,001–5,000", 1001, 5000),
        ("5,001–10,000", 5001, 10000),
        ("10,001–25,000", 10001, 25000),
        ("25,001–50,000", 25001, 50000),
        ("50,001+", 50001, float("inf")),
    ]
    bracket_counts = []
    bracket_labels = []
    for label, lo, hi in brackets:
        cnt = sum(1 for s in sales_arr if lo <= s <= hi)
        bracket_counts.append(cnt)
        bracket_labels.append(label)
    bars = ax.barh(bracket_labels, bracket_counts, color=ACCENT, alpha=0.8, edgecolor="white")
    for bar, cnt in zip(bars, bracket_counts):
        ax.text(bar.get_width() + 15, bar.get_y() + bar.get_height()/2,
                f"{cnt} ({cnt/TOTAL*100:.1f}%)", va="center", fontsize=7)
    ax.set_xlabel("Number of Customers", fontsize=8)

    # 3c – Top 15 customers
    ax = axes[1, 0]
    style_ax(ax, "Top 15 Customers by Sales")
    top15 = sorted(customers, key=lambda c: c["_sales"], reverse=True)[:15]
    names = [f"{c['first_name'][:10]} {c['surname'][:8]}" for c in top15]
    vals = [c["_sales"] for c in top15]
    bars = ax.barh(names[::-1], vals[::-1], color=GOLD, edgecolor="white")
    ax.set_xlabel("Total Sales (SEK)", fontsize=8)
    for bar, v in zip(bars, vals[::-1]):
        ax.text(bar.get_width() + 100, bar.get_y() + bar.get_height()/2,
                f"{v:,.0f}", va="center", fontsize=6.5)

    # 3d – Pareto (cumulative %)
    ax = axes[1, 1]
    style_ax(ax, "Pareto Analysis (Cumulative Revenue)")
    sorted_sales = np.sort(sales_arr)[::-1]
    cum = np.cumsum(sorted_sales) / sorted_sales.sum() * 100
    pct_x = np.arange(1, len(cum)+1) / len(cum) * 100
    ax.plot(pct_x, cum, color=ACCENT, linewidth=1.5)
    ax.fill_between(pct_x, cum, alpha=0.15, color=ACCENT)
    ax.axhline(80, color=ACCENT2, linestyle="--", linewidth=0.8, alpha=0.7)
    # Find where 80% is reached
    idx80 = np.searchsorted(cum, 80)
    pct80 = pct_x[idx80] if idx80 < len(pct_x) else 100
    ax.axvline(pct80, color=ACCENT2, linestyle="--", linewidth=0.8, alpha=0.7)
    ax.text(pct80 + 1, 75, f"Top {pct80:.0f}% of customers\ngenerate 80% of revenue",
            fontsize=7, color=ACCENT2)
    ax.set_xlabel("% of Customers (ranked by sales)", fontsize=8)
    ax.set_ylabel("Cumulative Revenue %", fontsize=8)

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 4 – Demographics
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(2, 2, figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)
    fig.suptitle("Customer Demographics", fontsize=15, fontweight="bold", y=0.97)

    # 4a – Age distribution
    ax = axes[0, 0]
    style_ax(ax, "Age Distribution")
    if len(ages_arr):
        ax.hist(ages_arr, bins=30, color=ACCENT, alpha=0.7, edgecolor="white")
        ax.axvline(ages_arr.mean(), color=ACCENT2, linestyle="--", label=f"Mean: {ages_arr.mean():.1f}")
        ax.legend(fontsize=7)
    ax.set_xlabel("Age", fontsize=8)
    ax.set_ylabel("Frequency", fontsize=8)

    # 4b – Gender split
    ax = axes[0, 1]
    style_ax(ax, "Gender Distribution")
    gc = Counter(c["_gender"] for c in customers)
    labels_g = list(gc.keys())
    vals_g = list(gc.values())
    colors_g = [ACCENT if l == "Male" else ACCENT2 if l == "Female" else "#CCCCCC" for l in labels_g]
    wedges, texts, autotexts = ax.pie(vals_g, labels=labels_g, autopct="%1.1f%%",
                                       colors=colors_g, startangle=90)
    for t in autotexts:
        t.set_fontsize(8)

    # 4c – Age vs Sales scatter
    ax = axes[1, 0]
    style_ax(ax, "Age vs Total Sales")
    age_sales = [(c["_age"], c["_sales"]) for c in customers if c["_age"] is not None and c["_sales"] > 0]
    if age_sales:
        a_, s_ = zip(*age_sales)
        ax.scatter(a_, s_, alpha=0.25, s=10, c=ACCENT, edgecolors="none")
        # Trend line
        z = np.polyfit(a_, s_, 1)
        p = np.poly1d(z)
        x_line = np.linspace(min(a_), max(a_), 100)
        ax.plot(x_line, p(x_line), color=ACCENT2, linewidth=1.5, linestyle="--", label="Trend")
        ax.legend(fontsize=7)
    ax.set_xlabel("Age", fontsize=8)
    ax.set_ylabel("Total Sales (SEK)", fontsize=8)

    # 4d – Gender × Age group bar
    ax = axes[1, 1]
    style_ax(ax, "Gender × Age Group")
    age_bins = [(18, 30), (31, 40), (41, 50), (51, 60), (61, 70), (71, 80), (81, 100)]
    bin_labels = ["18-30", "31-40", "41-50", "51-60", "61-70", "71-80", "81+"]
    male_counts = []
    female_counts = []
    for lo, hi in age_bins:
        male_counts.append(sum(1 for c in customers if c["_gender"] == "Male" and c["_age"] and lo <= c["_age"] <= hi))
        female_counts.append(sum(1 for c in customers if c["_gender"] == "Female" and c["_age"] and lo <= c["_age"] <= hi))
    x_pos = np.arange(len(bin_labels))
    w = 0.35
    ax.bar(x_pos - w/2, male_counts, w, label="Male", color=ACCENT, alpha=0.8)
    ax.bar(x_pos + w/2, female_counts, w, label="Female", color=ACCENT2, alpha=0.8)
    ax.set_xticks(x_pos)
    ax.set_xticklabels(bin_labels, fontsize=7)
    ax.legend(fontsize=7)
    ax.set_xlabel("Age Group", fontsize=8)
    ax.set_ylabel("Count", fontsize=8)

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 5 – Geographic Deep-Dive
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(2, 2, figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)
    fig.suptitle("Geographic Deep-Dive", fontsize=15, fontweight="bold", y=0.97)

    # 5a – Top 20 cities
    ax = axes[0, 0]
    style_ax(ax, "Top 20 Cities by Customer Count")
    city_counts = Counter(c.get("city", "").strip() for c in customers if c.get("city", "").strip())
    top_cities = city_counts.most_common(20)
    if top_cities:
        city_names, city_vals = zip(*top_cities)
        ax.barh(city_names[::-1], city_vals[::-1], color=GOLD, edgecolor="white")
        ax.set_xlabel("Customers", fontsize=8)

    # 5b – County pie chart
    ax = axes[0, 1]
    style_ax(ax, "Customer Share by County (Top 10)")
    county_c = Counter(c["_county"] for c in customers if c["_county"] != "Unknown")
    top10_counties = county_c.most_common(10)
    if top10_counties:
        cn_names, cn_vals = zip(*top10_counties)
        other = sum(county_c.values()) - sum(cn_vals)
        labels_cn = list(cn_names) + (["Other"] if other > 0 else [])
        vals_cn = list(cn_vals) + ([other] if other > 0 else [])
        cmap_pie = plt.cm.Set3
        colors_pie = [cmap_pie(i / len(labels_cn)) for i in range(len(labels_cn))]
        ax.pie(vals_cn, labels=labels_cn, autopct="%1.1f%%", colors=colors_pie,
               startangle=90, textprops={"fontsize": 7})

    # 5c – Avg sales per county
    ax = axes[1, 0]
    style_ax(ax, "Average Sales per Customer by County")
    avg_by_county = {cn: county_sales[cn]/county_count[cn] for cn in counties if county_count[cn] > 0}
    sorted_avg = sorted(avg_by_county.items(), key=lambda x: x[1], reverse=True)[:15]
    if sorted_avg:
        s_names, s_vals = zip(*sorted_avg)
        ax.barh(s_names[::-1], s_vals[::-1], color=ACCENT, edgecolor="white")
        ax.set_xlabel("Avg Sales (SEK)", fontsize=8)

    # 5d – Sales per county (stacked: <5k, 5k-20k, 20k+)
    ax = axes[1, 1]
    style_ax(ax, "Sales Tier Distribution by County (Top 12)")
    top12 = [cn for cn, _ in Counter({cn: county_count[cn] for cn in counties}).most_common(12)]
    tier_low, tier_mid, tier_high = [], [], []
    for cn in top12:
        cust_in = [c for c in customers if c["_county"] == cn]
        tier_low.append(sum(1 for c in cust_in if c["_sales"] < 5000))
        tier_mid.append(sum(1 for c in cust_in if 5000 <= c["_sales"] < 20000))
        tier_high.append(sum(1 for c in cust_in if c["_sales"] >= 20000))
    x_pos = np.arange(len(top12))
    ax.bar(x_pos, tier_low, label="<5k SEK", color="#81C784")
    ax.bar(x_pos, tier_mid, bottom=tier_low, label="5k–20k", color=GOLD)
    ax.bar(x_pos, tier_high, bottom=np.array(tier_low)+np.array(tier_mid), label="20k+", color=ACCENT2)
    ax.set_xticks(x_pos)
    ax.set_xticklabels(top12, fontsize=6, rotation=45, ha="right")
    ax.legend(fontsize=7)
    ax.set_ylabel("Customers", fontsize=8)

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 6 – Engagement & Banking
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(2, 2, figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)
    fig.suptitle("Engagement & Banking Analysis", fontsize=15, fontweight="bold", y=0.97)

    # 6a – Visits distribution
    ax = axes[0, 0]
    style_ax(ax, "Visits per Customer")
    visit_counts = Counter(c["_visits"] for c in customers)
    vis_labels = sorted(visit_counts.keys())[:15]
    vis_vals = [visit_counts[v] for v in vis_labels]
    ax.bar([str(v) for v in vis_labels], vis_vals, color=ACCENT, edgecolor="white")
    ax.set_xlabel("Number of Visits", fontsize=8)
    ax.set_ylabel("Customers", fontsize=8)

    # 6b – Marketing opt-in by county
    ax = axes[0, 1]
    style_ax(ax, "Marketing Opt-in Rate by County (Top 15)")
    mkt_by_county = {}
    for cn in counties:
        cn_custs = [c for c in customers if c["_county"] == cn]
        if len(cn_custs) >= 5:
            mkt_by_county[cn] = sum(1 for c in cn_custs if c["_marketing"]) / len(cn_custs) * 100
    sorted_mkt = sorted(mkt_by_county.items(), key=lambda x: x[1], reverse=True)[:15]
    if sorted_mkt:
        m_names, m_vals = zip(*sorted_mkt)
        ax.barh(m_names[::-1], m_vals[::-1], color=GOLD, edgecolor="white")
        ax.set_xlabel("Opt-in Rate (%)", fontsize=8)

    # 6c – Banking data completeness
    ax = axes[1, 0]
    style_ax(ax, "Banking Data Completeness")
    fields = ["iban_number", "bank_name", "bic_code"]
    field_labels = ["IBAN", "Bank Name", "BIC Code"]
    completeness = [sum(1 for c in customers if c.get(f)) / TOTAL * 100 for f in fields]
    bars = ax.bar(field_labels, completeness, color=[ACCENT, GOLD, ACCENT2], edgecolor="white")
    for bar, v in zip(bars, completeness):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1,
                f"{v:.1f}%", ha="center", fontsize=8)
    ax.set_ylabel("% Filled", fontsize=8)
    ax.set_ylim(0, 110)

    # 6d – Visits vs Sales
    ax = axes[1, 1]
    style_ax(ax, "Visits vs Total Sales")
    vs = [(c["_visits"], c["_sales"]) for c in customers if c["_sales"] > 0]
    if vs:
        v_, s_ = zip(*vs)
        ax.scatter(v_, s_, alpha=0.25, s=10, c=ACCENT, edgecolors="none")
        ax.set_xlabel("Visits", fontsize=8)
        ax.set_ylabel("Total Sales (SEK)", fontsize=8)

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

    # ════════════════════════════════════════════════════════════════════
    # PAGE 7 – Time Series & Key Insights
    # ════════════════════════════════════════════════════════════════════
    fig, axes = plt.subplots(2, 2, figsize=(14, 8.5))
    fig.patch.set_facecolor(BG)
    fig.suptitle("Time Analysis & Key Insights", fontsize=15, fontweight="bold", y=0.97)

    # 7a – Customer creation over time
    ax = axes[0, 0]
    style_ax(ax, "Customer Registrations Over Time")
    dates = []
    for c in customers:
        ca = c.get("created_at", "")
        if ca:
            try:
                dt = datetime.fromisoformat(ca.replace("Z", "+00:00"))
                dates.append(dt.strftime("%Y-%m-%d"))
            except Exception:
                pass
    if dates:
        dc = Counter(dates)
        sorted_dates = sorted(dc.keys())
        ax.bar(range(len(sorted_dates)), [dc[d] for d in sorted_dates],
               color=ACCENT, alpha=0.7, edgecolor="none")
        # Show only some labels
        step = max(1, len(sorted_dates) // 10)
        ax.set_xticks(range(0, len(sorted_dates), step))
        ax.set_xticklabels([sorted_dates[i] for i in range(0, len(sorted_dates), step)],
                           rotation=45, fontsize=6, ha="right")
    ax.set_ylabel("New Customers", fontsize=8)

    # 7b – Last visit recency
    ax = axes[0, 1]
    style_ax(ax, "Days Since Last Visit (Recency)")
    recencies = []
    today = datetime.now()
    for c in customers:
        lv = c.get("last_visit", "")
        if lv:
            try:
                lvd = datetime.fromisoformat(lv.replace("Z", "+00:00")).replace(tzinfo=None)
                recencies.append((today - lvd).days)
            except Exception:
                pass
    if recencies:
        ax.hist(recencies, bins=40, color=GOLD, alpha=0.7, edgecolor="white")
        ax.axvline(np.mean(recencies), color=ACCENT2, linestyle="--",
                   label=f"Mean: {np.mean(recencies):.0f} days")
        ax.legend(fontsize=7)
    ax.set_xlabel("Days Since Last Visit", fontsize=8)
    ax.set_ylabel("Customers", fontsize=8)

    # 7c – Birth year distribution
    ax = axes[1, 0]
    style_ax(ax, "Birth Year Distribution")
    birth_years = []
    for c in customers:
        dob = c.get("date_of_birth", "")
        if dob:
            try:
                birth_years.append(int(dob[:4]))
            except Exception:
                pass
    if birth_years:
        ax.hist(birth_years, bins=40, color=ACCENT, alpha=0.7, edgecolor="white")
    ax.set_xlabel("Birth Year", fontsize=8)
    ax.set_ylabel("Frequency", fontsize=8)

    # 7d – Key Insights text box
    ax = axes[1, 1]
    ax.axis("off")
    style_ax(ax, "Key Insights Summary")

    gender_c = Counter(c["_gender"] for c in customers)
    top_county = counties[0] if counties else "N/A"
    top_city = city_counts.most_common(1)[0] if city_counts else ("N/A", 0)
    zero_sales = sum(1 for s in sales_arr if s == 0)
    high_val = sum(1 for s in sales_arr if s >= 20000)

    insights = [
        f"• Total customers: {TOTAL:,}",
        f"• Total revenue: {total_rev:,.0f} SEK",
        f"• Average sale: {avg_sale:,.0f} SEK  |  Median: {median_sale:,.0f} SEK",
        f"• Highest single customer sale: {max_sale:,.0f} SEK",
        f"• Top region: {top_county} ({county_count.get(top_county,0):,} customers)",
        f"• Top city: {top_city[0]} ({top_city[1]:,} customers)",
        f"• Gender split: {gender_c.get('Male',0):,} M / {gender_c.get('Female',0):,} F",
        f"• Average age: {avg_age:.1f} years",
        f"• Zero-sales customers: {zero_sales:,} ({zero_sales/TOTAL*100:.1f}%)",
        f"• High-value (≥20k SEK): {high_val:,} ({high_val/TOTAL*100:.1f}%)",
        f"• Marketing opt-in: {pct_marketing:.1f}%",
        f"• IBAN on file: {pct_iban:.1f}%",
        f"• Pareto: Top {pct80:.0f}% of customers → 80% of revenue",
    ]
    ax.text(0.05, 0.95, "\n".join(insights), transform=ax.transAxes,
            fontsize=9, verticalalignment="top", fontfamily="monospace",
            bbox=dict(boxstyle="round,pad=0.5", facecolor="white", edgecolor=GOLD, alpha=0.9))

    fig.tight_layout(rect=[0, 0, 1, 0.93])
    pdf.savefig(fig)
    plt.close(fig)

print(f"\n✅ Report saved to: {OUT}")
print(f"   {TOTAL} customers analysed across 7 pages.")
