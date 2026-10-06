require('dotenv').config();
const {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const { buildLua, checkScriptExists, parseEncryptXLink } = require('./lib');
const { decode } = require('./sandbox');
const { createCaptureServer, createStore } = require('./server');

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');

const MAX_TOKENS_PER_USER = 3;
const MAX_CONCURRENT = 2;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_EXTRA_FILES = 3;

const EPHEMERAL = MessageFlags.Ephemeral;

const MESSAGES = {
  notEncryptX:
    '❌ هذا مو رابط سكربت Encrypt-X.\nالصيغة المقبولة:\n`https://encrypt-x.pages.dev/Scripts?Id=XXXX`',
  notFound: '❌ ما لقيت هذا السكربت في Encrypt-X، تأكد من الرابط.',
  busy: '❌ عندك طلب شغال حالياً، انتظر لين يخلص.',
  decoding: '⏳ جاري فك التشفير، ياخذ كم ثانية...',
  done: (id, size, stages) =>
    `✅ تم فك التشفير\n🆔 ID: \`${id}\`\n📦 الحجم: ${size} بايت${stages > 0 ? `\n🧩 مراحل إضافية: ${stages}` : ''}`,
  tooBig: '❌ انفك السكربت بس حجمه كبير مرة وما أقدر أرسله.',
  failed:
    '❌ ما قدرت أفك هذا السكربت على السيرفر. الملف debug.txt فيه سبب الفشل لو تبي ترسله لي.',
  fallback:
    '\n\nجرّب الطريقة اليدوية: انسخ السطر اللي تحت وشغّله في الاكسيكيوتر داخل أي لعبة، وانتظر حوالي 6 ثواني والناتج يوصلك هنا.\n⏳ الصلاحية 10 دقائق.',
  manualDone: (size) => `✅ تم سحب السكربت من الاكسيكيوتر (${size} بايت)`,
  manualEmpty:
    '❌ ما انسحب أي كود. غالباً السكربت ما استخدم loadstring، أو الاكسيكيوتر ما شغّله.',
  manualSendFailed:
    '❌ انسحب السكربت بس ما قدرت أرسله، الملف كبير. راجع الكليببورد في الاكسيكيوتر.',
  internal: '❌ صار خطأ غير متوقع، جرب مرة ثانية.',
};

const commands = [
  new SlashCommandBuilder()
    .setName('encryptxdeobf')
    .setDescription('فك تشفير سكربت من رابط Encrypt-X')
    .addStringOption((option) =>
      option.setName('link').setDescription('رابط سكربت Encrypt-X').setRequired(true)
    )
    .toJSON(),
];

const store = createStore();
const busyUsers = new Set();

let active = 0;
const waiting = [];

function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
}

function release() {
  const next = waiting.shift();
  if (next) {
    next();
  } else {
    active -= 1;
  }
}

async function onCode(entry, body) {
  const file = new AttachmentBuilder(body, { name: `${entry.id}.lua` });
  try {
    await entry.interaction.followUp({
      content: MESSAGES.manualDone(body.length),
      files: [file],
      flags: EPHEMERAL,
    });
  } catch (err) {
    console.error(err);
    await entry.interaction
      .followUp({ content: MESSAGES.manualSendFailed, flags: EPHEMERAL })
      .catch((error) => console.error(error));
  }
}

async function onEmpty(entry) {
  await entry.interaction
    .followUp({ content: MESSAGES.manualEmpty, flags: EPHEMERAL })
    .catch((err) => console.error(err));
}

async function sendDecoded(interaction, parsed, result) {
  if (result.main.length > MAX_FILE) {
    return interaction.editReply(MESSAGES.tooBig);
  }

  const files = [new AttachmentBuilder(result.main, { name: `${parsed.id}.lua` })];
  const extras = result.extra.filter((stage) => stage.length <= MAX_FILE).slice(0, MAX_EXTRA_FILES);
  extras.forEach((stage, index) => {
    files.push(new AttachmentBuilder(stage, { name: `${parsed.id}_stage${index + 1}.lua` }));
  });

  try {
    return await interaction.editReply({
      content: MESSAGES.done(parsed.id, result.main.length, extras.length),
      files,
    });
  } catch (err) {
    console.error(err);
    return interaction.editReply(MESSAGES.tooBig);
  }
}

async function sendFailure(interaction, parsed, result) {
  const debugFile = new AttachmentBuilder(Buffer.from(result.log || 'no log', 'utf8'), {
    name: 'debug.txt',
  });

  const canFallback =
    Boolean(PUBLIC_URL) && store.countByUser(interaction.user.id) < MAX_TOKENS_PER_USER;

  await interaction.editReply({
    content: MESSAGES.failed + (canFallback ? MESSAGES.fallback : ''),
    files: [debugFile],
  });

  if (!canFallback) {
    return null;
  }

  const token = store.create({
    userId: interaction.user.id,
    id: parsed.id,
    url: parsed.url,
    interaction,
  });

  return interaction.followUp({
    content: `loadstring(game:HttpGet("${PUBLIC_URL}/s/${token}"))()`,
    flags: EPHEMERAL | MessageFlags.SuppressEmbeds,
  });
}

async function handleCommand(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });

  const parsed = parseEncryptXLink(interaction.options.getString('link', true));
  if (!parsed) {
    return interaction.editReply(MESSAGES.notEncryptX);
  }

  const userId = interaction.user.id;
  if (busyUsers.has(userId)) {
    return interaction.editReply(MESSAGES.busy);
  }

  busyUsers.add(userId);
  try {
    const exists = await checkScriptExists(parsed.url);
    if (!exists) {
      return await interaction.editReply(MESSAGES.notFound);
    }

    await interaction.editReply(MESSAGES.decoding);

    await acquire();
    let result;
    try {
      result = await decode(parsed);
    } finally {
      release();
    }

    if (result.ok) {
      return await sendDecoded(interaction, parsed, result);
    }
    return await sendFailure(interaction, parsed, result);
  } finally {
    busyUsers.delete(userId);
  }
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

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing');
  process.exit(1);
}

const server = createCaptureServer({
  store,
  publicUrl: PUBLIC_URL,
  buildLua,
  onCode,
  onEmpty,
});

server.on('error', (err) => console.error(err));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on ${PORT} | Public URL: ${PUBLIC_URL || 'NOT SET'}`);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'encryptxdeobf') {
    return;
  }

  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error(err);
    const payload = { content: MESSAGES.internal, flags: EPHEMERAL };
    const send =
      interaction.deferred || interaction.replied
        ? interaction.editReply(MESSAGES.internal)
        : interaction.reply(payload);
    await send.catch((error) => console.error(error));
  }
});

client.on(Events.Error, (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));
process.on('uncaughtException', (err) => console.error(err));

client.login(TOKEN);
