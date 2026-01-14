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

def visualize_footprint(json_file='solar_footprint_data.json'):
    # Load the data
    try:
        with open(json_file, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"❌ Error: {json_file} not found. Run the footprint breakdown script first.")
        return

    # Convert farms to DataFrame
    df = pd.DataFrame(data['farms'])
    df['finalizedAt'] = pd.to_datetime(df['finalizedAt'])
    df = df.sort_values('finalizedAt')
    
    # Calculate cumulative metrics
    df['cumulativeWatts'] = df['wattsCaptured'].cumsum()
    df['cumulativePanels'] = df['cumulativeWatts'] / 400
    
    # Define Region Mapping and Colors (EXCLUDING CGP)
    region_labels = {2: 'Utah (UT)', 3: 'Missouri (MO)', 4: 'Colorado (CO)'}
    region_colors = {2: '#3b82f6', 3: '#10b981', 4: '#f59e0b'} # Blue, Green, Amber
    
    df['regionName'] = df['regionId'].map(lambda x: region_labels.get(x, f'Region {x}'))
    df['color'] = df['regionId'].map(lambda x: region_colors.get(x, '#6b7280'))

    # Set the style
    sns.set_theme(style="whitegrid")
    plt.rcParams['font.family'] = 'sans-serif'
    
    fig = plt.figure(figsize=(18, 14))
    plt.subplots_adjust(hspace=0.4, wspace=0.3)

    # Legend for the whole figure
    legend_patches = [mpatches.Patch(color=region_colors[rid], label=label) for rid, label in region_labels.items() if rid in df['regionId'].values]
    fig.legend(handles=legend_patches, loc='upper right', bbox_to_anchor=(0.95, 0.95), title="Regions", fontsize=12)

    # 1. Cumulative Growth (Line Chart)
    ax1 = plt.subplot(2, 2, 1)
    sns.lineplot(data=df, x='finalizedAt', y='cumulativeWatts', marker='o', ax=ax1, color='#f59e0b', linewidth=3)
    ax1.fill_between(df['finalizedAt'], df['cumulativeWatts'], color='#f59e0b', alpha=0.15)
    ax1.set_title('Cumulative Solar Footprint Growth', fontsize=14, fontweight='bold', pad=15)
    ax1.set_xlabel('Finalization Date', fontsize=12)
    ax1.set_ylabel('Total Watts (Captured)', fontsize=12)
    
    # Add a panel count twin axis
    ax1_panels = ax1.twinx()
    ax1_panels.set_ylim(ax1.get_ylim()[0]/400, ax1.get_ylim()[1]/400)
    ax1_panels.set_ylabel('Panels Equivalent', fontsize=12, color='#92400e')
    ax1_panels.grid(False)

    # 2. Watts Captured by Region (Pie Chart)
    ax2 = plt.subplot(2, 2, 2)
    region_totals = df.groupby('regionId')['wattsCaptured'].sum()
    labels = [region_labels.get(r, f'Region {r}') for r in region_totals.index]
    colors = [region_colors.get(r, '#6b7280') for r in region_totals.index]
    
    wedges, texts, autotexts = ax2.pie(region_totals, labels=labels, autopct='%1.1f%%', 
                                     startangle=140, colors=colors, 
                                     wedgeprops={'edgecolor': 'white', 'linewidth': 2, 'alpha': 0.8},
                                     textprops={'fontsize': 12, 'fontweight': 'bold'})
    ax2.set_title('Regional Distribution of Impact', fontsize=14, fontweight='bold', pad=15)

    # 3. Weekly Activity (Spikes in capture)
    ax3 = plt.subplot(2, 2, 3)
    weekly_capture = df.groupby(['weekNumber', 'regionId'])['wattsCaptured'].sum().reset_index()
    weekly_capture['date'] = weekly_capture['weekNumber'].apply(week_to_date)
    weekly_capture['date_label'] = weekly_capture['date'].dt.strftime('%b %d')
    
    # Plot bars stacked or grouped
    sns.barplot(data=weekly_capture, x='date_label', y='wattsCaptured', hue='regionId', 
                palette=region_colors, ax=ax3, dodge=True)
    ax3.set_title('Weekly Captured Power by Region', fontsize=14, fontweight='bold', pad=15)
    ax3.set_xlabel('Protocol Week (End Date)', fontsize=12)
    ax3.set_ylabel('Watts Captured (New)', fontsize=12)
    ax3.get_legend().remove() # Use global legend

    # 4. Top Farms Analysis (Horizontal Bar)
    ax4 = plt.subplot(2, 2, 4)
    top_farms = df.nlargest(12, 'wattsCaptured').copy()
    
    bars = sns.barplot(data=top_farms, x='wattsCaptured', y='farmName', 
                      hue='regionId', palette=region_colors, ax=ax4, dodge=False)
    ax4.set_title('Top Individual Farm Contributions', fontsize=14, fontweight='bold', pad=15)
    ax4.set_xlabel('Watts Captured from Farm', fontsize=12)
    ax4.set_ylabel('')
    ax4.get_legend().remove()

    # Add labels to the top farms
    for i, p in enumerate(ax4.patches):
        width = p.get_width()
        if width > 0:
            ax4.text(width + 50, p.get_y() + p.get_height()/2, 
                    f'{int(width):,}W', va='center', fontsize=10)

    # Add a global title
    wallet_short = data['walletAddress'][:10] + '...' + data['walletAddress'][-8:]
    plt.suptitle(f"Solar Impact Summary: {wallet_short}\n"
                 f"Verified: {data['summary']['totalWatts']:,} Watts | "
                 f"Equiv: {data['summary']['totalPanels']} Panels | "
                 f"Weeks Active: {df['weekNumber'].nunique()}", 
                 fontsize=20, fontweight='bold', y=1.02)

    # Footer note
    fig.text(0.5, 0.01, f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC • Data starting Week {df['weekNumber'].min()}", 
             ha='center', fontsize=10, color='gray', style='italic')

    # Save and show
    output_file = 'solar_footprint_analysis.png'
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"✅ Enhanced visualization saved to {output_file}")
    plt.show()

if __name__ == "__main__":
    visualize_footprint()

if __name__ == "__main__":
    visualize_footprint()
