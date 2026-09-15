<script lang="ts">
	let {
		origin,
		activeRole,
		lanIps,
		copiedLink,
		onCopy
	}: {
		origin: string;
		activeRole: string;
		lanIps?: { name: string; address: string }[];
		copiedLink: string | null;
		onCopy: (text: string, label: string) => void;
	} = $props();

	const ROLES = [
		{ role: 'left', title: 'Left Window Screen', desc: '-30° Yaw Offset Panorama', icon: '◀️' },
		{
			role: 'center',
			title: 'Center Window Screen',
			desc: '0° Leader & Flight Director',
			icon: '⏺️'
		},
		{ role: 'right', title: 'Right Window Screen', desc: '+30° Yaw Offset Panorama', icon: '▶️' },
		{ role: 'solo', title: 'Solo Window Display', desc: 'Standalone Single Kiosk', icon: '🚀' }
	] as const;
</script>

<section class="card">
	<h2>🖥️ Multi-Screen Panorama Displays</h2>
	<p class="card-desc">
		Launch continuous 3-screen panoramic windows or solo kiosk instances across local network
		devices.
	</p>

	<div class="display-roles-grid">
		{#each ROLES as item}
			{@const roleUrl = `${origin}/?role=${item.role}`}
			<div class="role-card" class:active={activeRole === item.role}>
				<div class="role-header">
					<span class="role-icon">{item.icon}</span>
					<div>
						<div class="role-title">{item.title}</div>
						<div class="role-desc">{item.desc}</div>
					</div>
				</div>
				<div class="role-url-box">
					<code>{roleUrl}</code>
				</div>
				<div class="role-actions">
					<a href={roleUrl} target="_blank" rel="noreferrer" class="btn primary">Launch Screen ↗</a>
					<button type="button" class="btn secondary" onclick={() => onCopy(roleUrl, item.role)}>
						{copiedLink === item.role ? '✓ Copied URL!' : 'Copy URL'}
					</button>
				</div>
			</div>
		{/each}
	</div>

	{#if lanIps && lanIps.length > 0}
		<div class="network-interfaces">
			<h3>Local LAN Access IP Addresses:</h3>
			<div class="ip-list">
				<!-- Keyed: this list is refetched every 20 s and interfaces come and
				     go (WiFi associating, a tunnel raising utun). Unkeyed, Svelte
				     patches in place, so a removed interface leaves the row below it
				     wearing the wrong copy-button target. The other `{#each}` blocks
				     on this page iterate module constants and cannot reorder. -->
				{#each lanIps as net (net.name + net.address)}
					{@const ipUrl = `http://${net.address}:5173/`}
					<div class="ip-row">
						<span class="iface-name">{net.name}:</span>
						<code>{ipUrl}</code>
						<button type="button" class="btn xs" onclick={() => onCopy(ipUrl, net.address)}>
							{copiedLink === net.address ? '✓ Copied' : 'Copy'}
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</section>
