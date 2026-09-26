<!-- AdminSoftware — OTA update trigger + result. Markup verbatim. -->
<script lang="ts">
	import type { RestAdminStore } from '$lib/fleet/rest-admin.svelte';
	import { fanOut } from '$lib/fleet/fan-out';

	let { getTargets, store, selectedCount }: {
		getTargets: () => string[],
		store: RestAdminStore,
		selectedCount: number
	} = $props();

	let updateResult = $state<{ ok: number; failed: string[] } | null>(null);
	let updating = $state(false);

	async function handleUpdateNow() {
		const targets = getTargets();
		if (targets.length === 0 || updating) return;
		updating = true;
		updateResult = null;
		try {
			updateResult = await fanOut(targets, async (id) => {
				const { ok, detail } = await store.triggerUpdate(id);
				if (!ok) throw new Error(detail ?? 'update failed');
			});
		} finally {
			updating = false;
		}
	}
</script>

			<section class="control-section">
				<h3>Software</h3>
				<p class="section-caption">
					Pulls the CI-approved <code>release</code> branch, rebuilds on the device and restarts.
					Devices go offline ~1 min; confirm by their commit chip changing.
				</p>
				<button class="btn btn-secondary" onclick={handleUpdateNow} disabled={updating}>
					{updating ? 'Triggering…' : `Update Now ${selectedCount > 0 ? `(${selectedCount})` : '(All)'}`}
				</button>
				{#if updateResult}
					<p class="update-result" class:has-failures={updateResult.failed.length > 0}>
						{updateResult.ok} triggered{updateResult.failed.length ? `, ${updateResult.failed.length} failed` : ''}
						{#if updateResult.failed.length}
							<span class="update-failed">{updateResult.failed.join(' · ')}</span>
						{/if}
					</p>
				{/if}
			</section>
