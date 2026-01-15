import json
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import matplotlib.patches as mpatches

GENESIS_TIMESTAMP = 1700352000

def week_to_date(week):
    # Add 1 to the week to get the timestamp for the end of that protocol week
    return datetime.fromtimestamp(GENESIS_TIMESTAMP + (week + 1) * 604800)

def visualize_points(json_file='solar_footprint_data.json'):
    # Load the data
    try:
        with open(json_file, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"❌ Error: {json_file} not found. Run the expanded diagnostic script first.")
        return

    if 'weeks' not in data:
        print("❌ Error: JSON does not contain 'weeks' history. Run generate-impact-diagnostics.ts first.")
        return

    # Convert weeks to DataFrame
    df = pd.DataFrame(data['weeks'])
    df['date'] = df['weekNumber'].apply(week_to_date)
    df = df.sort_values(['weekNumber', 'regionId'])
    
    # Define Region Mapping and Colors (EXCLUDING CGP)
    region_labels = {2: 'Utah (UT)', 3: 'Missouri (MO)', 4: 'Colorado (CO)'}
    region_colors = {2: '#3b82f6', 3: '#10b981', 4: '#f59e0b'} # Blue, Green, Amber
    
    # Set the style
    sns.set_theme(style="whitegrid")
    plt.rcParams['font.family'] = 'sans-serif'
    
    fig = plt.figure(figsize=(16, 18))
    plt.subplots_adjust(hspace=0.4, wspace=0.3)

    # Legend patches for reuse
    legend_patches = [mpatches.Patch(color=region_colors[rid], label=label) 
                     for rid, label in region_labels.items() if rid in df['regionId'].values]

    # 1. Total Power Evolution (Stacked Bar by Region)
    ax1 = plt.subplot(3, 1, 1)
    # Pivot for stacking
    pivot_df = df.pivot(index='date', columns='regionId', values='totalPoints').fillna(0)
    pivot_df.index = pivot_df.index.map(lambda x: x.strftime('%b %d\n%Y'))
    pivot_df.plot(kind='bar', stacked=True, ax=ax1, 
                 color=[region_colors.get(rid, '#6b7280') for rid in pivot_df.columns])
    
    ax1.set_title('Total Capture Power Evolution (Points per Week)', fontsize=16, fontweight='bold', pad=20)
    ax1.set_xlabel('Finalization Date', fontsize=12)
    ax1.set_ylabel('Total Power Points', fontsize=12)
    ax1.legend(handles=legend_patches, title="Regions", loc='upper left', bbox_to_anchor=(1, 1))

    # 2. Source Breakdown (Granular Sources)
    ax2 = plt.subplot(3, 1, 2)
    source_df = df.groupby('date').agg({
        'inflationPoints': 'sum', 
        'steeringPoints': 'sum', 
        'vaultBonusPoints': 'sum', 
        'glowWorthPoints': 'sum'
    }).reset_index()
    
    source_df['date_label'] = source_df['date'].dt.strftime('%b %d\n%Y')
    
    # Rename for cleaner legend
    source_df.rename(columns={
        'inflationPoints': 'Emissions (Inflation)',
        'steeringPoints': 'Steering (sGCTL)',
        'vaultBonusPoints': 'Vault Bonus (Delegations)',
        'glowWorthPoints': 'GlowWorth (Holdings)'
    }, inplace=True)
    
    # Define colors for the sources
    source_colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f43f5e'] # Green, Blue, Purple, Pink
    
    source_df.set_index('date_label').drop(columns=['date']).plot(
        kind='bar', stacked=True, ax=ax2, color=source_colors
    )
    
    ax2.set_title('Power Composition by Source (Emissions, Steering, Vault, Worth)', fontsize=16, fontweight='bold', pad=20)
    ax2.set_xlabel('Finalization Date', fontsize=12)
    ax2.set_ylabel('Points', fontsize=12)
    ax2.legend(loc='upper left', bbox_to_anchor=(1, 1))

    # 3. Regional Influence Trend (% Share of Network per Region)
    ax3 = plt.subplot(3, 1, 3)
    for rid in df['regionId'].unique():
        region_df = df[df['regionId'] == rid]
        sns.lineplot(data=region_df, x='date', y='sharePercent', marker='o', 
                    color=region_colors.get(rid, '#6b7280'), label=region_labels.get(rid, f'R{rid}'),
                    linewidth=3, markersize=8, ax=ax3)
    
    ax3.set_title('Regional Influence Trend (% Share of Total Network Power)', fontsize=16, fontweight='bold', pad=20)
    ax3.set_xlabel('Finalization Date', fontsize=12)
    ax3.set_ylabel('Network Share (%)', fontsize=12)
    ax3.set_ylim(0, max(df['sharePercent']) * 1.3)
    ax3.legend(title="Regions", loc='upper left', bbox_to_anchor=(1, 1))

    # Add a global title
    wallet_short = data['walletAddress'][:10] + '...' + data['walletAddress'][-8:]
    plt.suptitle(f"Power & Influence Analysis: {wallet_short}\n"
                 f"Max Share: {df['sharePercent'].max():.2f}% | "
                 f"Regions: {', '.join([region_labels[r] for r in df['regionId'].unique() if r in region_labels])}", 
                 fontsize=22, fontweight='bold', y=0.98)

    # Footer note
    fig.text(0.5, 0.02, f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC • Note: Power = Direct Points + GlowWorth Points", 
             ha='center', fontsize=10, color='gray', style='italic')

    # Save and show
    output_file = 'points_analysis.png'
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"✅ Points analysis saved to {output_file}")
    plt.show()

if __name__ == "__main__":
    visualize_points()
