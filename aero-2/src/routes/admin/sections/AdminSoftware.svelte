<script lang="ts">
	/**
	 * The on-demand OTA trigger.
	 *
	 * The endpoint existed with no UI — an operator pushing a fix had to know
	 * to curl POST /api/update with a bearer token, which on a headless fleet
	 * means "had to read the source". The timer remains the delivery path
	 * (every ~15 min, rollback included); this is the same unit started now.
	 *
	 * The token is asked for PER USE and held in memory only. /admin has no
	 * authentication of its own — AERO_ADMIN_UI is a deployment gate, not an
	 * identity — so persisting the admin token in this page (localStorage, a
	 * cookie) would promote "can see the cockpit" into "can restart the wall".
	 * A field the operator pastes into keeps the credential where it belongs:
	 * with the operator.
	 */
	let updateToken = $state('');
	let updateStatus = $state<string | null>(null);
	let updateBusy = $state(false);

	async function triggerUpdate() {
		if (!updateToken || updateBusy) return;
		updateBusy = true;
		updateStatus = null;
		try {
			const res = await fetch('/api/update', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${updateToken}`,
					// SvelteKit's CSRF guard rejects a same-origin POST whose
					// content-type looks form-like; without an explicit JSON type this
					// fetch answered 403 "Cross-site POST forbidden" from INSIDE the
					// admin page. Found by driving the real button, not by reading.
					'content-type': 'application/json'
				},
				body: '{}'
			});
			const body = (await res.json()) as { message?: string; error?: string };
			updateStatus = res.ok
				? (body.message ?? 'Update triggered.')
				: `${res.status}: ${body.error ?? body.message ?? 'refused'}`;
		} catch (err) {
			updateStatus = err instanceof Error ? err.message : 'unreachable';
		} finally {
			updateBusy = false;
		}
	}
</script>

<div class="update-row">
	<input
		type="password"
		placeholder="AERO_ADMIN_TOKEN"
		bind:value={updateToken}
		aria-label="Admin token for update trigger"
	/>
	<button
		type="button"
		class="glass-btn"
		disabled={!updateToken || updateBusy}
		onclick={triggerUpdate}
	>
		{updateBusy ? 'Triggering…' : 'Update fleet now'}
	</button>
</div>
{#if updateStatus}
	<p class="fleet-note">{updateStatus}</p>
{/if}
