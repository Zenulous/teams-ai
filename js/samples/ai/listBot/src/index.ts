// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Import required packages
import { config } from 'dotenv';
import * as path from 'path';
import * as restify from 'restify';

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
import {
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication,
    ConfigurationBotFrameworkAuthenticationOptions,
    MemoryStorage,
    ResourceResponse,
    TurnContext
} from 'botbuilder';

// Read botFilePath and botFileSecret from .env file.
const ENV_FILE = path.join(__dirname, '..', '.env');
config({ path: ENV_FILE });

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(process.env as ConfigurationBotFrameworkAuthenticationOptions);

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about how bots work.
const adapter = new CloudAdapter(botFrameworkAuthentication);

// Create storage to use
//const storage = new MemoryStorage();

// Catch-all for errors.
const onTurnErrorHandler = async ( context, error ) => {
    // This check writes out errors to console log .vs. app insights.
    // NOTE: In production environment, you should consider logging this to Azure
    //       application insights.
    console.error( `\n [onTurnError] unhandled error: ${ error }` );

    // Send a trace activity, which will be displayed in Bot Framework Emulator
    await context.sendTraceActivity(
        'OnTurnError Trace',
        `${ error }`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
    );

    // Send a message to the user
    await context.sendActivity( 'The bot encountered an error or bug.' );
    await context.sendActivity( 'To continue to run this bot, please fix the bot source code.' );
};

// Set the onTurnError for the singleton CloudAdapter.
adapter.onTurnError = onTurnErrorHandler;

// Create HTTP server.
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

server.listen(process.env.port || process.env.PORT || 3978, () => {
    console.log( `\n${ server.name } listening to ${ server.url }` );
    console.log( '\nGet Bot Framework Emulator: https://aka.ms/botframework-emulator' );
    console.log( '\nTo talk to your bot, open the emulator select "Open Bot"' );
});

import { Application, DefaultTurnState, OpenAIPredictionEngine, AI } from 'botbuilder-m365';

// Create prediction engine
const predictionEngine = new OpenAIPredictionEngine({
    configuration: {
        apiKey: process.env.OPENAI_API_KEY
    },
    prompt: path.join(__dirname, '../src/prompt.txt'),
    promptConfig: {
        model: "text-davinci-003",
        temperature: 0.0,
        max_tokens: 256,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0.6,
        stop: [" Human:", " AI:"],
    },
    topicFilter: path.join(__dirname, '../src/topicFilter.txt'),
    topicFilterConfig: {
        model: "text-davinci-003",
        temperature: 0.0,
        max_tokens: 256,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0.6,
        stop: [" Human:", " AI:"],
    },
    logRequests: true
});

// Strongly type the applications turn state
interface ConversationState {
    listNames: string[];
    lists: Record<string, string[]>;
}
type ApplicationTurnState = DefaultTurnState<ConversationState>;

// Define storage and application
const storage = new MemoryStorage();
const app = new Application<ApplicationTurnState>({
    storage,
    predictionEngine
});

// Define an interface to strongly type data parameters for actions
interface EntityData {
    list: string;       // <- populated by GPT
    item: string;       // <- populated by GPT
    items?: string[];   // <- populated by the summarizeList action
    lists?: Record<string, string[]> 
}

// Register action handlers
app.ai.action('addItem', async (context, state, data: EntityData) => {
    const items = getItems(state, data.list);
    items.push(data.item);
    setItems(state, data.list, items);
    return true;    
});

app.ai.action('removeItem', async (context, state, data: EntityData) => {
    const items = getItems(state, data.list);
    const index = items.indexOf(data.item);
    if (index >= 0) {
        items.splice(index, 1);
        setItems(state, data.list, items);
        return true;
    } else {
        await sendActivity(context, [
            `I couldn't find that item in the list.`,
            `Hmm... Can't find it. Sure you spelled it right?`
        ]);

        // End the current chain
        return false;
    }
});

app.ai.action('findItem', async (context, state, data: EntityData) => {
    const items = getItems(state, data.list);
    const index = items.indexOf(data.item);
    if (index >= 0) {
        await sendActivity(context, `I found ${data.item} in your ${data.list} list.`);
    } else {
        await sendActivity(context, [
            `I couldn't find ${data.item} in your ${data.list} list.`,
            `Hmm... I don't see ${data.item} in your ${data.list} list.`
        ]);
    }

    // End the current chain
    return false;    
});

app.ai.action('summarizeList', async (context, state, data: EntityData) => {
    data.items = getItems(state, data.list);   

    // Chain into a new summarization prompt
    await callPrompt(context, state, '../src/summarizeList.txt', data);

    // End the current chain
    return false;
});

app.ai.action('summarizeAllLists', async (context, state, data: EntityData) => {
    data.lists = state.conversation.value.lists;
    if (data.lists) {
        // Chain into a new summarization prompt
        await callPrompt(context, state, '../src/summarizeAllLists.txt', data);
    } else {
        await sendActivity(context, [
            `I couldn't find any lists.`,
            `Hmm... You don't seem to have any lists yet.`
        ]);
    }

    // End the current chain
    return false;
});

// Register a handler to handle unknown actions that might be predicted
app.ai.action(AI.UnknownActionName, async (context, state, data, action) => {
    await context.sendActivity(`I don't know how to do '${action}'.`);
    return false;
});

// Register a handler to deal with a user asking something off topic
app.ai.action(AI.OffTopicActionName, async (context, state) => {
    await context.sendActivity(`I'm sorry, I'm not allowed to talk about such things...`);
    return false;
});

// Listen for incoming server requests.
server.post('/api/messages', async (req, res) => {
    // Route received a request to adapter for processing
    await adapter.process(req, res as any, async (context) => {
        // Dispatch to application for routing
        await app.run(context);
    });
});

function callPrompt(context: TurnContext, state: ApplicationTurnState, prompt: string, data: Record<string, any>): Promise<boolean> {
    return app.ai.chain(
        context, 
        state, 
        data, 
        {
            prompt: path.join(__dirname, prompt),
            promptConfig: {
                model: "text-davinci-003",
                temperature: 0.7,
                max_tokens: 256,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0
            }
        });
}

function sendActivity(context: TurnContext, message: string|string[]): Promise<ResourceResponse> {
    if (Array.isArray(message)) {
        const index = Math.floor(Math.random() * (message.length - 1));
        return context.sendActivity(message[index]);
    } else {
        return context.sendActivity(message);
    }
}

function getItems(state: ApplicationTurnState, list: string): string[] {
    ensureListExists(state, list);
    return state.conversation.value.lists[list];
}

function setItems(state: ApplicationTurnState, list: string, items: string[]): void {
    ensureListExists(state, list);
    state.conversation.value.lists[list] = items ?? [];
}

function ensureListExists(state: ApplicationTurnState, listName: string): void {
    if (typeof state.conversation.value.lists != 'object') {
        state.conversation.value.lists = {};
        state.conversation.value.listNames = [];
    }

    if (!state.conversation.value.lists.hasOwnProperty(listName)) {
        state.conversation.value.lists[listName] = [];
        state.conversation.value.listNames.push(listName);
    }
}