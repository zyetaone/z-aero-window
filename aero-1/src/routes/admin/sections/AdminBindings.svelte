<!-- AdminBindings — device fingerprint bindings. Fully self-contained. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listBindings,
		saveBinding,
		deleteBinding,
		getDeviceFingerprint,
		resolveBinding,
		type DeviceRole,
		type DeviceBinding,
	} from '$lib/fleet/parallax.svelte';
	import { DEVICE_ROLES } from '$lib/types';

	const ROLE_OPTIONS: DeviceRole[] = ['solo', ...DEVICE_ROLES.filter(r => r !== 'solo')];
	let bindings = $state<Array<{ fingerprint: string; binding: DeviceBinding }>>([]);
	let myFingerprint = $state('');
	let myBinding = $state<DeviceBinding>({ role: 'solo', groupId: 'default' });
	let formRole = $state<DeviceRole>('solo');
	let formGroup = $state('default');

	function refreshBindings() {
		if (typeof window === 'undefined') return;
		myFingerprint = getDeviceFingerprint();
		myBinding = resolveBinding();
		bindings = listBindings();
		formRole = myBinding.role;
		formGroup = myBinding.groupId;
	}
	onMount(() => { refreshBindings(); });

	function handleSaveMyBinding() {
		handleSetBinding(myFingerprint, formRole, formGroup);
	}
	function handleSetBinding(fp: string, role: DeviceRole, groupId: string) {
		if (!groupId.trim()) return;
		saveBinding(fp, { role, groupId: groupId.trim() });
		refreshBindings();
	}
	function handleDeleteBinding(fp: string) {
		deleteBinding(fp);
		refreshBindings();
	}
</script>

			<section class="control-section">
				<h3>Device Bindings</h3>
				<div class="bindings-my">
					<p class="bindings-caption">This device</p>
					<code class="bindings-fp" title={myFingerprint}>{myFingerprint}</code>
					<div class="bindings-form">
						<select bind:value={formRole} class="select">
							{#each ROLE_OPTIONS as r (r)}
								<option value={r}>{r}</option>
							{/each}
						</select>
						<input type="text" class="input" bind:value={formGroup} placeholder="groupId" />
						<button class="btn btn-secondary" onclick={handleSaveMyBinding}>Save</button>
					</div>
					<p class="bindings-hint">
						Current: <strong>{myBinding.role}</strong> / <strong>{myBinding.groupId}</strong>
						<br /><span class="muted">Applies on next playground load. Visit /admin on each pane to bind.</span>
					</p>
				</div>
				{#if bindings.length > 0}
					<p class="bindings-caption">Known bindings (this browser)</p>
					<ul class="bindings-list">
						{#each bindings as entry (entry.fingerprint)}
							<li class={['bindings-row', entry.fingerprint === myFingerprint && 'me']}>
								<code class="bindings-fp-small" title={entry.fingerprint}>{entry.fingerprint.slice(0, 8)}</code>
								<select
									class="select"
									value={entry.binding.role}
									onchange={(e) => handleSetBinding(entry.fingerprint, (e.currentTarget as HTMLSelectElement).value as DeviceRole, entry.binding.groupId)}
								>
									{#each ROLE_OPTIONS as r (r)}
										<option value={r}>{r}</option>
									{/each}
								</select>
								<input
									type="text"
									class="input input-sm"
									value={entry.binding.groupId}
									onchange={(e) => handleSetBinding(entry.fingerprint, entry.binding.role, (e.currentTarget as HTMLInputElement).value)}
								/>
								<button
									class="btn-x"
									aria-label="Delete binding"
									onclick={() => handleDeleteBinding(entry.fingerprint)}
								>✕</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
