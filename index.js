require('dotenv').config();
const {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
} = require('discord.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TOKEN = process.env.DISCORD_TOKEN;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'channels.json');

const SEND_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
];

const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('تحديد روم الترحيب')
    .toJSON(),
];

let channels = {};
try {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    channels = parsed;
  }
} catch {
  channels = {};
}

let writeQueue = Promise.resolve();

function saveChannels() {
  const task = writeQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(channels, null, 2));
    await fsp.rename(tmp, DATA_FILE);
    return true;
  });
  writeQueue = task.catch(() => {});
  return task.catch((err) => {
    console.error(err);
    return false;
  });
}

function welcomeText(member) {
  const username = escapeMarkdown(member.user.username);
  const server = escapeMarkdown(member.guild.name);

  return `🎉 أهلًا وسهلًا بك في سيرفرنا! 🎉

╭・👋 العضو: <@${member.id}>
├・👤 اليوزر: @${username}
├・🏠 السيرفر: ${server}
├・👥 عدد الأعضاء: ${member.guild.memberCount}
╰・🔥 نورت السيرفر بوجودك!

📜 لا تنسَ قراءة القوانين والاطلاع على الأقسام المهمة.
🤝 شاركنا وتعرّف على أعضاء السيرفر واستمتع بوقتك معنا!

«❤️ نتمنى لك إقامة سعيدة في ${server}!
✨ نورتنا يا ${username}!»`;
}

function reply(interaction, content, ephemeral) {
  const payload = ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
  const send =
    interaction.replied || interaction.deferred
      ? interaction.followUp(payload)
      : interaction.reply(payload);
  return send.catch((err) => console.error(err));
}

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`Commands registered in "${guild.name}" (${guild.id})`);
  } catch (err) {
    console.error(
      `Failed to register commands in "${guild.name}" (${guild.id}) | code: ${err.code ?? 'none'} | ${err.message}`
    );
    if (err.code === 50001) {
      console.error(
        'Missing Access: re-invite the bot with BOTH scopes: bot + applications.commands'
      );
    }
  }
}

async function handleSetChannel(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    return reply(interaction, '❌ هذا الأمر يشتغل داخل السيرفر بس.', true);
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return reply(interaction, '❌ لازم تكون عندك صلاحية Manage Server.', true);
  }

  const channel =
    interaction.channel ??
    (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));

  const allowedTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  if (!channel || !allowedTypes.includes(channel.type)) {
    return reply(interaction, '❌ استخدم الأمر داخل روم كتابي عادي.', true);
  }

  const me = await interaction.guild.members.fetchMe().catch(() => null);
  if (!me || !channel.permissionsFor(me)?.has(SEND_PERMISSIONS)) {
    return reply(
      interaction,
      '❌ ما عندي صلاحية أشوف الروم وأرسل فيه، عطني View Channel و Send Messages.',
      true
    );
  }

  channels[interaction.guild.id] = channel.id;
  const saved = await saveChannels();

  if (!saved) {
    return reply(
      interaction,
      '✅ تم تحديد هنا\n⚠️ ما قدرت أحفظه بشكل دائم، ممكن يرجع بعد إعادة التشغيل.'
    );
  }
  return reply(interaction, '✅ تم تحديد هنا');
}

async function handleMemberAdd(member) {
  if (member.user.bot) {
    return;
  }

  const channelId = channels[member.guild.id];
  if (!channelId) {
    return;
  }

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const me = await member.guild.members.fetchMe().catch(() => null);
  if (!me || !channel.permissionsFor(me)?.has(SEND_PERMISSIONS)) {
    return;
  }

  const payload = {
    content: welcomeText(member),
    allowedMentions: { users: [member.id] },
  };

  if (channel.permissionsFor(me)?.has(PermissionFlagsBits.EmbedLinks)) {
    payload.embeds = [
      new EmbedBuilder().setImage(member.user.displayAvatarURL({ size: 512 })),
    ];
  }

  await channel.send(payload);
}

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `Logged in as ${readyClient.user.tag} | Application ID: ${readyClient.user.id} | Servers: ${readyClient.guilds.cache.size}`
  );

  try {
    await readyClient.application.commands.set([]);
  } catch (err) {
    console.error(err);
  }

  for (const guild of readyClient.guilds.cache.values()) {
    await registerCommands(guild);
  }
});

client.on(Events.GuildCreate, (guild) => registerCommands(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'setchannel') {
    return;
  }

  try {
    await handleSetChannel(interaction);
  } catch (err) {
    console.error(err);
    await reply(interaction, '❌ صار خطأ غير متوقع، جرب مرة ثانية.', true);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberAdd(member);
  } catch (err) {
    console.error(err);
  }
});

client.on(Events.Error, (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));
process.on('uncaughtException', (err) => console.error(err));

client.login(TOKEN);
