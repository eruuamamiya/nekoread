import { DiscordSDK } from '@discord/embedded-app-sdk';

// Hanya jalan kalau dibuka dari dalam Discord
if (new URLSearchParams(location.search).has('frame_id')) {
  // Host di Discord selalu <CLIENT_ID>.discordsays.com
  const CLIENT_ID = location.hostname.split('.')[0];
  const sdk = new DiscordSDK(CLIENT_ID);
  const startedAt = Date.now();

  const emit = (list = []) =>
    window.dispatchEvent(new CustomEvent('discord-users', {
      detail: list.map((u) => ({
        name: u.global_name || u.username,
        avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : '',
      })),
    }));

  // Izin diminta sekali; kalau ditolak, Activity tetap jalan tanpa presence detail
  let authP;
  const auth = () => (authP ??= (async () => {
    const { code } = await sdk.commands.authorize({
      client_id: CLIENT_ID,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify', 'rpc.activities.write'],
    });
    const r = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, client_id: CLIENT_ID }),
    });
    const { access_token } = await r.json();
    await sdk.commands.authenticate({ access_token });
    return true;
  })().catch((e) => { console.warn('Presence nonaktif:', e); return false; }));

  const setPresence = async (r) => {
    if (!(await auth())) return;
    try {
      await sdk.commands.setActivity({
        activity: {
          type: 0,
          details: r ? (r.title ? `Baca ${r.title}` : 'Baca manga') : 'Cari bacaan',
          state: r?.chapter || undefined,
          timestamps: { start: startedAt },
        },
      });
    } catch (e) { console.warn('setActivity gagal:', e); }
  };

  // index.html mengirim event ini tiap user pindah halaman / chapter
  // Debounce supaya tidak kena rate limit setActivity saat user cepat pindah halaman
  let timer;
  window.addEventListener('nekoread-reading', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setPresence(e.detail), 800);
  });

  (async () => {
    await sdk.ready();
    try {
      emit((await sdk.commands.getInstanceConnectedParticipants()).participants);
      sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', (d) => emit(d.participants));
    } catch (e) { console.warn('Participants gagal:', e); }
    setPresence(window.__reading ?? null);
  })();
}
