# -*- coding: utf-8 -*-
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

fig, ax = plt.subplots(1, 1, figsize=(32, 18))
ax.set_xlim(1998, 2028)
ax.set_ylim(-1, 28)

ax.set_title(
    'MES/MOM System Architecture Research Evolution (2000\u20132026)\n'
    'MES/MOM\u7cfb\u7edf\u67b6\u6784\u7814\u7a76\u5e74\u4efd\u53d1\u5c55\u56fe',
    fontsize=18, fontweight='bold', pad=22
)

for s in ['top', 'right', 'left']:
    ax.spines[s].set_visible(False)
ax.spines['bottom'].set_position(('data', -0.5))
ax.tick_params(left=False, labelleft=False)
ax.set_xticks(range(2000, 2028, 2))

C = {
    'mono': '#78909C', 'std': '#7E57C2', 'dist': '#FFB74D',
    'ai': '#66BB6A', 'gap': '#EF5350',
}

def pbg(x1, x2, c, lab, a=0.30):
    ax.add_patch(mpatches.Rectangle((x1, -1), x2 - x1, 28, facecolor=c, alpha=a, zorder=0, linewidth=0))
    ax.text((x1 + x2) / 2, 27.4, lab, ha='center', va='top', fontsize=13, fontweight='bold', color='#333', alpha=0.6)

def bar(x1, x2, y, lab, c, a=0.55):
    ax.add_patch(mpatches.FancyBboxPatch((x1, y - 0.18), x2 - x1, 0.36,
        boxstyle="round,pad=0.03", facecolor=c, alpha=a, edgecolor=c, linewidth=1.5, zorder=4))
    ax.text((x1 + x2) / 2, y - 0.42, lab, ha='center', va='top', fontsize=8.5, color='#333', fontweight='bold')

def node(x, y, lab, c, m='s', s=13):
    ax.plot(x, y, m, color=c, markersize=s, zorder=5, markeredgecolor='white', markeredgewidth=1.5)
    ax.text(x, y - 0.40, lab, ha='center', va='top', fontsize=8.2, color='#333',
        bbox=dict(boxstyle='round,pad=0.25', facecolor=c, alpha=0.12, edgecolor=c, linewidth=0.7))

def ms(x, y, lab, c, s=14):
    ax.plot(x, y, 'D', color=c, markersize=s, zorder=6, markeredgecolor='white', markeredgewidth=1.8)
    ax.text(x, y - 0.42, lab, ha='center', va='top', fontsize=8.5, fontweight='bold', color=c,
        bbox=dict(boxstyle='round,pad=0.3', facecolor='white', edgecolor=c, linewidth=1.5))

def arr(x1, x2, y, c='#666'):
    ax.annotate('', xy=(x2 - 0.3, y), xytext=(x1 + 0.3, y),
        arrowprops=dict(arrowstyle='->', color=c, lw=2))

def conn(x, y1, y2, c='#999'):
    ax.annotate('', xy=(x, y2), xytext=(x, y1), arrowprops=dict(arrowstyle='->', color=c, lw=1.5))

def dline(x):
    ax.axvline(x=x, color='#BDBDBD', linestyle='--', linewidth=0.7, alpha=0.5, zorder=1)

def pbox(x, y, w, h, lab, c):
    ax.add_patch(mpatches.FancyBboxPatch((x - w / 2, y - h / 2), w, h,
        boxstyle="round,pad=0.05", facecolor=c, alpha=0.15, edgecolor=c, linewidth=1.5, zorder=4))
    ax.text(x, y, lab, ha='center', va='center', fontsize=8, color='#444', fontweight='bold')

# ============ PHASE BACKGROUNDS ============
pbg(1998, 2007, C['mono'], 'Phase I: Monolithic MES (~1998\u20132007)')
pbg(2007, 2015, C['std'], 'Phase II: Standardization & Ref. Architecture (~2007\u20132015)')
pbg(2015, 2021, C['dist'], 'Phase III: Distributed / DDD-driven (~2015\u20132021)')
pbg(2021, 2026.5, C['ai'], 'Phase IV: AI-driven & Intelligent (~2021\u20132026)')
pbg(2026.5, 2028, C['gap'], 'Future', 0.35)
for px in [2007, 2015, 2021]:
    dline(px)

# ============ ROW 0: Macro Evolution ============
ax.text(1997.5, 26.5, 'Macro\nEvolution', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2007, 26.8, 'Single Factory / Monolithic MES', C['mono'])
bar(2007, 2015, 26.8, 'MES \u2192 MOM / Reference Architecture', C['std'])
bar(2015, 2021, 26.8, 'CMMN / DDD Microservice', C['dist'])
bar(2021, 2026.5, 26.8, 'AI-Assisted / Neuro-Symbolic', C['ai'])
bar(2026.5, 2028, 26.8, 'Autonomous Orchestration', C['gap'], 0.4)
arr(2007, 2015, 26.55); arr(2015, 2021, 26.55); arr(2021, 2026.5, 26.55)

# ============ ROW 1: Standards ============
ax.text(1997.5, 24.8, 'Standards', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(2000, 2010, 25.0, 'ISA-95 / ISO 62264: Activity Models, 4-Domain [3][23]', C['std'])
ms(2003, 24.5, 'ISA-95 Part 1&2\n[23]', C['std'])
ms(2007, 24.5, 'ISO 62264 Part 3\nActivity Models [3]', C['std'])
ms(2015, 25.0, 'RAMI 4.0\n3D Cube\nHierarchy+Lifecycle\n+Layers [24]', C['std'], 15)
node(2016, 24.5, 'AAS Standard\n(IIC+Plattform 4.0)\n[48]', C['std'], 'D')
ms(2020, 24.5, 'Common Service\nModel Interface\n[49][50]', C['std'])
conn(2007, 24.5, 24.9, C['std']); conn(2016, 24.5, 24.9, C['std'])

# ============ ROW 2: Architecture Pattern ============
ax.text(1997.5, 22.4, 'Arch.\nPattern', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2007, 22.6, 'Monolithic / Tightly-coupled', C['mono'])
bar(2007, 2015, 22.6, 'Layered / SOA', C['std'])
bar(2015, 2021, 22.6, 'Microservice / DDD + Bounded Context', C['dist'])
bar(2021, 2026.5, 22.6, 'AI + DDD + Multi-Agent', C['ai'])
arr(2007, 2015, 22.35); arr(2015, 2021, 22.35); arr(2021, 2026.5, 22.35)

# ============ ROW 3: Key Research ============
ax.text(1997.5, 20.4, 'Key\nResearch', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
node(2000, 20.5, 'MES Functional\nBoundary Def. [37]', C['mono'])
node(2003, 20.0, 'MES-ML\nWitsch et al.\n[4][32]', C['mono'])
node(2007, 20.5, 'ISA-95 \u2192 MOM\nFramework\nExpansion', C['std'])
node(2010, 20.0, 'SysML Automation\nVogel-Heuser [12]', C['std'])
node(2012, 20.5, 'MDE / PIM\nAuto Transform\n[12]', C['std'])
node(2015, 20.5, 'CMMN\nJohansen et al.\n[25][1][2]', C['dist'])
node(2017, 20.0, 'DDD + Bounded\nContext for MOM\n[11]', C['dist'])
node(2019, 20.5, 'Event Storming\nExpert-driven\nDecomposition', C['dist'])
node(2022, 20.5, 'AI Co-developer\nLow-Code\n(Liwanag) [39]', C['ai'])
node(2023, 20.0, 'Jonathan Silva\nAI Arch. Decomp\n[38]', C['ai'])
node(2024, 20.5, 'LLM + DDD\nAuto Decomp\n[17][18]', C['ai'])
ms(2026, 20.5, 'ToT + SHERPA\nMulti-Agent\nOrchestration\n[17][18][19]', C['ai'], 15)

# ============ ROW 4: System Boundary ============
ax.text(1997.5, 18.1, 'System\nBoundary', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2007, 18.3, 'Single Factory / Shop-floor', C['mono'])
bar(2007, 2015, 18.3, 'Multi-site / Vertical Integration', C['std'])
bar(2015, 2021, 18.3, 'Cross-Enterprise / CMMN Network', C['dist'])
bar(2021, 2026.5, 18.3, 'Global Supply Chain + AI Orchestration', C['ai'])
arr(2007, 2015, 18.05); arr(2015, 2021, 18.05); arr(2021, 2026.5, 18.05)

# ============ ROW 5: Decomposition ============
ax.text(1997.5, 15.9, 'Decomp.\nMethod', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2007, 16.1, 'Manual / Waterfall', C['mono'])
bar(2007, 2015, 16.1, 'Functional Decomposition / Module', C['std'])
bar(2015, 2022, 16.1, 'DDD + Event Storming (Expert-driven)', C['dist'])
bar(2022, 2026.5, 16.1, 'AI-Assisted Decomp. (ToT/LLM)', C['ai'])
bar(2026.5, 2028, 16.1, 'Autonomous Decomp. + Dispatch', C['gap'], 0.4)
arr(2007, 2015, 15.85); arr(2015, 2022, 15.85); arr(2022, 2026.5, 15.85)

# ============ ROW 6: Tech Stack ============
ax.text(1997.5, 13.7, 'Tech\nStack', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2007, 13.9, 'UML / SysML / BPMN', C['mono'])
bar(2007, 2015, 13.9, 'DSML (MES-ML) / MDE / PIM', C['std'])
bar(2015, 2021, 13.9, 'DDD / Microservice / Low-Code/NC', C['dist'])
bar(2021, 2026.5, 13.9, 'LLM / Neuro-Symbolic / Multi-Agent RAG', C['ai'])
bar(2026.5, 2028, 13.9, 'Cognitive Orchestration Engine', C['gap'], 0.4)
arr(2007, 2015, 13.65); arr(2015, 2021, 13.65); arr(2021, 2026.5, 13.65)

# ============ ROW 7: Low-Code Mapping ============
ax.text(1997.5, 11.4, 'Low-Code\nMapping', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
bar(1998, 2010, 11.6, '(pre-era: custom-coded integration)', C['mono'], 0.30)
node(2013, 11.6, 'Raybould\nCitizen Developer\nBarriers [26]', C['std'], 'D')
node(2018, 11.6, 'Rena et al.\nMOM Concept\nPlatform Valid.', C['dist'], 'D')
node(2021, 11.6, 'Bounded Context\n\u2192 Microservice\nComponent [26]', C['dist'], 'D')
node(2023, 11.0, 'Liwanag\nAI Co-developer\nLow-Code [39]', C['ai'], 's')
node(2024, 11.0, 'LLM+DataOps\n+Low-Code\nClosed Loop [47]', C['ai'], 's')

# ============ ROW 8: Pain Points ============
ax.text(1997.5, 9.2, 'Pain\nPoints', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
pbox(2003, 9.3, 2.2, 1.2, 'IT-OT Gap', C['mono'])
pbox(2010, 9.3, 2.5, 1.2, 'Semantic Ambiguity\nAcross Views', C['std'])
pbox(2017, 9.3, 2.8, 1.2, 'DDD Manual Split:\nHigh Complexity\n& Workload', C['dist'])
pbox(2023, 9.3, 3.0, 1.2, 'LLM Hallucination:\nNo Deterministic\nIndustrial Reasoning', C['ai'])
pbox(2026, 9.3, 3.1, 1.2, 'Intention \u2192 Dispatch\nGap: No End-to-End\nOrchestration', C['gap'])

# ============ ROW 9: Critical Gap ============
ax.text(1997.5, 7.2, 'Critical\nGap', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
ax.add_patch(mpatches.FancyBboxPatch((2021.5, 6.85), 6.5, 0.7, boxstyle="round,pad=0.08",
    facecolor=C['gap'], alpha=0.10, edgecolor=C['gap'], linewidth=2, linestyle='--', zorder=3))
ax.text(2024.75, 7.2,
    'From Architecture Decomposition to Automatic Task Dispatch:\n'
    'Missing Unified Cognitive Orchestration & Dynamic Allocation Architecture\n'
    '(\u4ece\u67b6\u6784\u62c6\u5206\u5230\u4efb\u52a1\u81ea\u52a8\u6d3e\u53d1\uff1a\u7f3a\u4e4f\u7edf\u4e00\u7684\u8ba4\u77e5\u7f16\u6392\u4e0e\u52a8\u6001\u5206\u914d\u67b6\u6784)',
    ha='center', va='center', fontsize=10.5, fontweight='bold', color=C['gap'])

# ============ ROW 10: Future Trends ============
ax.text(1997.5, 5.2, 'Future\nTrend', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
trends = [
    (2023, 'Business Scenario-Driven\n(\u4e1a\u52a1\u573a\u666f\u9a71\u52a8)', C['ai']),
    (2024.5, 'Global Object Trace\n(\u5168\u5c40\u5bf9\u8c61\u8ddf\u8e2a)', C['ai']),
    (2025.5, 'LLM + Domain Model\nFusion (\u5927\u5c0f\u6a21\u578b\u878d\u5408)', C['ai']),
    (2026.5, 'Autonomous Decomp.\n+ Dispatch\n(\u81ea\u4e3b\u5206\u89e3\u4e0e\u6d3e\u53d1)', C['gap']),
]
for i, (tx, tl, tc) in enumerate(trends):
    ax.text(tx, 5.45, tl, ha='center', va='center', fontsize=9, fontweight='bold',
        color=tc, bbox=dict(boxstyle='round,pad=0.3', facecolor='white', edgecolor=tc, linewidth=1.8))
    if i < len(trends) - 1:
        arr(tx + 0.35, trends[i + 1][0] - 0.35, 5.25, tc)

# ============ ROW 11: Citation Timeline ============
ax.text(1997.5, 3.0, 'Core\nCitations', fontsize=11, fontweight='bold', color='#333', ha='center', va='center')
cits = [
    (2000, '[37] MES Func.', C['mono']),
    (2003, '[23] ISA-95', C['std']),
    (2007, '[3] ISO 62264', C['std']),
    (2009, '[4][32] MES-ML', C['std']),
    (2011, '[12] SysML Auto', C['std']),
    (2014, '[11] DDD Evans', C['dist']),
    (2015, '[24] RAMI 4.0', C['std']),
    (2016, '[48] AAS Std.', C['std']),
    (2017, '[25][1][2] Johansen CMMN', C['dist']),
    (2019, '[26] Raybould LC', C['dist']),
    (2022, '[39] Liwanag AI', C['ai']),
    (2023, '[38] Silva Decomp', C['ai']),
    (2024, '[47] LC+DataOps+LLM', C['ai']),
    (2025, '[17][18] ToT+SHERPA', C['ai']),
    (2026, '[19] Multi-Agent RAG', C['ai']),
]
for cx, cl, cc in cits:
    ax.plot(cx, 3.15, 'o', color=cc, markersize=7, zorder=5, markeredgecolor='white', markeredgewidth=0.8)
    ax.text(cx, 2.85, cl, ha='center', va='top', fontsize=6.8, color=cc, rotation=60)

# ============ Legend ============
leg = [
    mpatches.Patch(facecolor=C['mono'], alpha=0.5, label='Phase I: Monolithic MES (1998\u20132007)'),
    mpatches.Patch(facecolor=C['std'], alpha=0.5, label='Phase II: Standardization (2007\u20132015)'),
    mpatches.Patch(facecolor=C['dist'], alpha=0.5, label='Phase III: DDD / CMMN (2015\u20132021)'),
    mpatches.Patch(facecolor=C['ai'], alpha=0.5, label='Phase IV: AI-Driven (2021\u20132026)'),
    mpatches.Patch(facecolor=C['gap'], alpha=0.4, label='Future / Current Gap'),
]
ax.legend(handles=leg, loc='lower right', fontsize=9, ncol=5, framealpha=0.85, edgecolor='#ccc')

ax.annotate(
    'Data Source: MOM Multi-Model Aggregation & Semantic Distribution\n'
    '-- Dissertation Proposal v3.1 (\u00a72.2), Beihang University\n'
    'Generated by Claude Code (Opus 4.8)',
    xy=(2027, 1.5), fontsize=8, color='#aaa', ha='right', va='bottom',
    bbox=dict(boxstyle='round', facecolor='#f5f5f5', edgecolor='#ddd')
)

plt.tight_layout(pad=2)
out = r'C:\Users\123\Desktop\1\ub2e4\ubaa8\ub378 \uacf5\uad6c \uc81c\uc2dc \ub2e8\uc5b4 2026-7-2\MES-MOM\uc2dc\uc2a4\ud15c \uad6c\uc870 \uc5f0\uad6c_\ub144\ub3c4 \ubc1c\uc804\ub3c4.png'
print('Trying to save...')
try:
    plt.savefig(out, dpi=200, bbox_inches='tight', facecolor='white')
    print('Saved:', out)
except Exception as e:
    print('Error:', e)
    # fallback
    import os
    cwd = os.getcwd()
    fallback = os.path.join(cwd, 'MES-MOM_arch_timeline.png')
    plt.savefig(fallback, dpi=200, bbox_inches='tight', facecolor='white')
    print('Fallback saved:', fallback)
plt.close()
