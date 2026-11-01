import { DiscordSDK } from '@discord/embedded-app-sdk';

// Hanya jalan kalau dibuka dari dalam Discord
if (new URLSearchParams(location.search).has('frame_id')) {
  // Host di Discord selalu <CLIENT_ID>.discordsays.com
  const sdk = new DiscordSDK(location.hostname.split('.')[0]);

  const emit = (list = []) =>
    window.dispatchEvent(new CustomEvent('discord-users', {
      detail: list.map((u) => ({
        name: u.global_name || u.username,
        avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : '',
      })),
    }));

  (async () => {
    await sdk.ready();
    try {
      emit((await sdk.commands.getInstanceConnectedParticipants()).participants);
      sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', (d) => emit(d.participants));
    } catch (e) { console.warn('Participants gagal:', e); }
  })();
}
