const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, PermissionsBitField } = require('discord.js');
const fs = require('fs');
require('dotenv').config();
require('./command');
const responses = require('./responses.json');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const logChannelId = process.env.LOG_CHANNEL_ID;
const roleId = process.env.ROLE_ID;
const applicationsFile = 'applications.json';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() && !interaction.isButton()) return;

  if (interaction.isCommand()) {
    if (interaction.commandName === 'تقديم') {
      // Check if user already applied
      const existingApplications = loadApplications();
      if (existingApplications.includes(interaction.user.id)) {
        await interaction.reply({ content: responses.alreadyApplied, ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('تقديم')
        .setDescription(responses.applyPrompt);

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('apply')
            .setLabel('تقديم')
            .setStyle(ButtonStyle.Primary)
        );

      await interaction.reply({ embeds: [embed], components: [row] });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'apply') {
      const bannedUsers = loadBannedUsers();
      if (bannedUsers.includes(interaction.user.id)) {
        await interaction.reply({ content: responses.applyblock, ephemeral: true });
        return;
      }

      // Check if user already applied
      const existingApplications = loadApplications();
      if (existingApplications.includes(interaction.user.id)) {
        await interaction.reply({ content: responses.alreadyApplied, ephemeral: true });
        return;
      }

      const member = interaction.member;

      const channel = await interaction.guild.channels.create({
        name: `تقديم-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: interaction.guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: member.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          },
        ],
      });

      await interaction.reply({ content: `تم فتح قناة التقديم ${channel}`, ephemeral: true });

      const questions = [
        'السؤال الأول؟',
        'السؤال الثاني؟',
        'السؤال الثالث؟',
        'السؤال الرابع؟',
        'السؤال الخامس؟',
      ];

      let answers = [];

      const askQuestion = async (i) => {
        if (i < questions.length) {
          await channel.send(`<@${member.id}> ${questions[i]}`);
          const filter = response => response.author.id === member.id;
          const collector = channel.createMessageCollector({ filter, max: 1 });

          collector.on('collect', async response => {
            answers.push(response.content);
            await askQuestion(i + 1);
          });
        } else {
          const userAvatarUrl = member.user.displayAvatarURL({ dynamic: true });

          const fields = questions.map((question, index) => ({
            name: question,
            value: answers[index],
          }));

          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('إجابات التقديم')
            .addFields(fields)
            .setThumbnail(userAvatarUrl)
            .setTimestamp();

          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder().setCustomId('approve').setLabel('موافقة').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('reject').setLabel('رفض').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('delete').setLabel('حذف').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('ban').setLabel('حظر').setStyle(ButtonStyle.Danger),
            );

          const logChannel = interaction.guild.channels.cache.get(logChannelId);
          if (logChannel) {
            await logChannel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] });
            await channel.send(responses.sendSuccess);
            await channel.delete(); // حذف القناة بعد الانتهاء

            // Save user application ID
            saveApplication(member.id);
          } else {
            console.error('Log channel not found. Please check the channel ID.');
          }
        }
      };

      await askQuestion(0);
    }

    if (['approve', 'reject', 'ban'].includes(interaction.customId)) {
      await interaction.deferReply({ ephemeral: true });

      const userId = interaction.message.mentions.users.first().id;
      const user = await interaction.guild.members.fetch(userId);

      try {
        switch(interaction.customId) {
          case 'approve':
            const role = interaction.guild.roles.cache.get(roleId);
            if (role) {
              await user.roles.add(role);
              await sendDM(user, true);
              await disableButtons(interaction.message, ['delete']);
              await interaction.followUp({ content: responses.approveMessage });
              // Remove user application ID
              removeApplication(userId);
            } else {
              await interaction.followUp({ content: 'لم يتم العثور على الدور.' });
            }
            break;
          case 'reject':
            await sendDM(user, false);
            await disableButtons(interaction.message, ['delete']);
            await interaction.followUp({ content: responses.rejectMessage });
            // Remove user application ID
            removeApplication(userId);
            break;
          case 'ban':
            const bannedUsers = loadBannedUsers();
            bannedUsers.push(userId);
            fs.writeFileSync('bannedUsers.json', JSON.stringify(bannedUsers, null, 2));
            await disableButtons(interaction.message, ['delete']);
            await interaction.followUp({ content: responses.banMessage });
            // Remove user application ID
            removeApplication(userId);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Error handling interaction:', error);
      }
    }

    if (interaction.customId === 'delete') {
      await interaction.deferReply({ ephemeral: true });

      try {
        await interaction.message.delete();
        await interaction.followUp({ content: responses.deleteMessage });
        // Remove user application ID
        const userId = interaction.message.mentions.users.first().id;
        removeApplication(userId);
      } catch (error) {
        console.error('Error deleting message:', error);
      }
    }
  }
});

async function sendDM(user, approved) {
  const message = approved ? responses.approveMessage : responses.rejectMessage;

  const embed = new EmbedBuilder()
    .setColor(approved ? 0x00FF00 : 0xFF0000)
    .setTitle('رد على طلب التقديم')
    .setDescription(message)
    .setTimestamp();

  try {
    await user.send({ embeds: [embed] });
  } catch (error) {
    console.error(`Could not send DM to ${user.tag}:`, error);
  }
}

async function disableButtons(message, excludeIds = []) {
  try {
    const components = message.components.map(row => {
      const updatedRow = new ActionRowBuilder();
      row.components.forEach(button => {
        if (!excludeIds.includes(button.customId)) {
          updatedRow.addComponents(ButtonBuilder.from(button).setDisabled(true));
        } else {
          updatedRow.addComponents(ButtonBuilder.from(button));
        }
      });
      return updatedRow;
    });

    await message.edit({ components });
  } catch (error) {
    console.error('Error disabling buttons:', error);
  }
}

function loadBannedUsers() {
  try {
    const bannedUsers = fs.readFileSync('bannedUsers.json', 'utf8');
    return JSON.parse(bannedUsers);
  } catch (error) {
    console.error('Error loading banned users:', error);
    return [];
  }
}

function saveApplication(userId) {
  try {
    const existingApplications = loadApplications();
    existingApplications.push(userId);
    fs.writeFileSync(applicationsFile, JSON.stringify(existingApplications, null, 2));
  } catch (error) {
    console.error('Error saving application:', error);
  }
}

function loadApplications() {
  try {
    const applications = fs.readFileSync(applicationsFile, 'utf8');
    return JSON.parse(applications);
  } catch (error) {
    console.error('Error loading applications:', error);
    return [];
  }
}

function removeApplication(userId) {
  try {
    let existingApplications = loadApplications();
    existingApplications = existingApplications.filter(id => id !== userId);
    fs.writeFileSync(applicationsFile, JSON.stringify(existingApplications, null, 2));
  } catch (error) {
    console.error('Error removing application:', error);
  }
}

// Handling uncaught exceptions
process.on('uncaughtException', err => {
  console.error('There was an uncaught error', err);
  // Optionally, you could restart the bot here or take other recovery actions
});

// Handling unhandled promise rejections
process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection at:', reason.stack || reason);
  // Optionally, you could restart the bot here or take other recovery actions
});

client.login(process.env.BOT_TOKEN);
