// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Database, Model} from '@nozbe/watermelondb';

import {scheduleExpiredNotification} from '@actions/local/push_notification';
import ServerDataOperator from '@app/database/operator/server_data_operator';
import type {Client} from '@client/rest';
import {General, Preferences} from '@constants';
import DatabaseManager from '@database/manager';
import {getPreferenceValue, getTeammateNameDisplaySetting} from '@helpers/api/preference';
import {selectDefaultTeam} from '@helpers/api/team';
import NetworkManager from '@init/network_manager';
import {prepareMyChannelsForTeam} from '@queries/servers/channel';
import {prepareMyPreferences, queryPreferencesByCategoryAndName} from '@queries/servers/preference';
import {prepareCommonSystemValues, queryCommonSystemValues, queryCurrentTeamId, queryWebSocketLastDisconnected, setCurrentTeamAndChannelId} from '@queries/servers/system';
import {addChannelToTeamHistory, deleteMyTeams, prepareMyTeams, prepareDeleteTeam, queryMyTeams, queryTeamsById} from '@queries/servers/team';
import {prepareUsers, queryCurrentUser} from '@queries/servers/user';
import type TeamModel from '@typings/database/models/servers/team';
import {selectDefaultChannelForTeam} from '@utils/channel';

import {fetchMissingSidebarInfo, fetchMyChannelsForTeam, MyChannelsRequest} from './channel';
import {fetchPostsForChannel, fetchPostsForUnreadChannels} from './post';
import {MyPreferencesRequest, fetchMyPreferences} from './preference';
import {fetchRolesIfNeeded} from './role';
import {ConfigAndLicenseRequest, fetchConfigAndLicense} from './systems';
import {fetchMyTeams, fetchTeamsChannelsAndUnreadPosts, MyTeamsRequest} from './team';
import {fetchMe, MyUserRequest} from './user';

type AfterLoginArgs = {
    serverUrl: string;
    user: UserProfile;
    deviceToken?: string;
}

type AppEntryData = {
    initialTeamId: string;
    teamData: MyTeamsRequest;
    chData: MyChannelsRequest;
    prefData: MyPreferencesRequest;
    meData: MyUserRequest;
    removeTeamIds: string[];
}

const fetchAppEntryData = async (database: Database, serverUrl: string, initialTeamId: string): Promise<AppEntryData> => {
    const lastDisconnected = await queryWebSocketLastDisconnected(database);
    const includeDeletedChannels = true;
    const fetchOnly = true;

    // Fetch in parallel teams / team membership / team unreads / channels for current team / user preferences / user
    const promises: [Promise<MyTeamsRequest>, Promise<MyChannelsRequest>, Promise<MyPreferencesRequest>, Promise<MyUserRequest>] = [
        fetchMyTeams(serverUrl, fetchOnly),
        fetchMyChannelsForTeam(serverUrl, initialTeamId, includeDeletedChannels, lastDisconnected, fetchOnly),
        fetchMyPreferences(serverUrl, fetchOnly),
        fetchMe(serverUrl),
    ];

    const resolved = await Promise.all(promises);
    const [teamData, chData, prefData, meData] = resolved; // eslint-disable-line @typescript-eslint/no-unused-vars

    const removeTeamIds: string[] = [];

    if (teamData.teams?.length === 0) {
        // User is no longer a member of any team
        const myTeams = await queryMyTeams(database);
        myTeams?.forEach((myTeam) => removeTeamIds.push(myTeam.id), removeTeamIds);

        return {
            initialTeamId: '',
            teamData,
            chData,
            prefData,
            meData,
            removeTeamIds,
        };
    }

    const inTeam = teamData.teams?.find((t) => t.id === initialTeamId);
    if (!inTeam || chData.error?.status_code === 403) {
        // User is no longer a member of the current team
        removeTeamIds.push(initialTeamId);

        const availableTeamIds = await getAvailableTeamIds(database, teamData.teams, prefData.preferences, meData.user?.locale, initialTeamId);
        const switchedTeamData = await switchTeams(serverUrl, availableTeamIds, removeTeamIds, includeDeletedChannels, lastDisconnected, fetchOnly);

        return {
            teamData,
            chData,
            prefData,
            meData,
            ...switchedTeamData,
        };
    }

    return {initialTeamId, teamData, chData, prefData, meData, removeTeamIds};
};

const getAvailableTeamIds = async (database: Database, teams: Team[] | undefined, preferences: PreferenceType[] | undefined, locale: string | undefined, excludeTeamId: string): Promise<string[]> => {
    let availableTeamIds: string[] = [];

    if (teams) {
        let teamOrderPreference;
        if (preferences) {
            teamOrderPreference = getPreferenceValue(preferences, Preferences.TEAMS_ORDER, '', '') as string;
        } else {
            const dbPreferences = await queryPreferencesByCategoryAndName(database, Preferences.TEAMS_ORDER, '');
            teamOrderPreference = dbPreferences[0].value;
        }

        const userLocale = locale || (await queryCurrentUser(database))?.locale;
        const {config} = await queryCommonSystemValues(database);

        const defaultTeam = selectDefaultTeam(teams, userLocale, teamOrderPreference, config.ExperimentalPrimaryTeam);

        availableTeamIds = [defaultTeam!.id];
    } else {
        const dbTeams = await queryMyTeams(database);
        if (dbTeams) {
            availableTeamIds = dbTeams.map((team) => team.id);
        }
    }

    return availableTeamIds.filter((id) => id !== excludeTeamId);
};

const switchTeams = async (serverUrl: string, availableTeamIds: string[], removeTeamIds: string[], includeDeleted = true, since = 0, fetchOnly = false) => {
    let initialTeamId = '';
    let chData;

    for (const teamId of availableTeamIds) {
        // eslint-disable-next-line no-await-in-loop
        chData = await fetchMyChannelsForTeam(serverUrl, teamId, includeDeleted, since, fetchOnly);
        if (chData.error?.status_code === 403) {
            removeTeamIds.push(teamId);
        } else {
            initialTeamId = teamId;
            break;
        }
    }

    if (chData) {
        return {initialTeamId, chData, removeTeamIds};
    }

    return {initialTeamId, removeTeamIds};
};

const handleRoles = async (serverUrl: string, teamData: MyTeamsRequest, chData: MyChannelsRequest, meData: MyUserRequest) => {
    const rolesToFetch = new Set<string>(meData.user?.roles.split(' ') || []);

    if (!teamData.error) {
        const teamRoles: string[] = [];
        const teamMembers: string[] = [];

        teamData.memberships?.forEach((tm) => {
            teamRoles.push(...tm.roles.split(' '));
            teamMembers.push(tm.team_id);
        });

        teamRoles.forEach(rolesToFetch.add, rolesToFetch);
    }

    if (chData.channels?.length && chData.memberships?.length) {
        const {channels, memberships} = chData;
        const channelIds = new Set(channels?.map((c) => c.id));
        for (let i = 0; i < memberships!.length; i++) {
            const member = memberships[i];
            if (channelIds.has(member.channel_id)) {
                member.roles.split(' ').forEach(rolesToFetch.add, rolesToFetch);
            }
        }
    }

    fetchRolesIfNeeded(serverUrl, Array.from(rolesToFetch));
};

const prepareModels = async (
    operator: ServerDataOperator,
    initialTeamId: string | undefined,
    removeTeams: TeamModel[] | undefined,
    teamData: MyTeamsRequest | undefined,
    chData: MyChannelsRequest | undefined,
    prefData: MyPreferencesRequest | undefined,
    meData: MyUserRequest | undefined): Promise<Array<Promise<Model[]>>> => {
    const modelPromises: Array<Promise<Model[]>> = [];

    if (removeTeams?.length) {
        for (const team of removeTeams) {
            const deleteModels = prepareDeleteTeam(team);
            modelPromises.push(deleteModels);
        }
    }

    if (teamData?.teams) {
        const teamModels = prepareMyTeams(operator, teamData.teams!, teamData.memberships!, teamData.unreads!);
        if (teamModels) {
            modelPromises.push(...teamModels);
        }
    }

    if (initialTeamId && chData?.channels?.length) {
        const channelModels = await prepareMyChannelsForTeam(operator, initialTeamId, chData.channels, chData.memberships!);
        if (channelModels) {
            modelPromises.push(...channelModels);
        }
    }

    if (prefData?.preferences) {
        const prefModel = prepareMyPreferences(operator, prefData.preferences!);
        if (prefModel) {
            modelPromises.push(prefModel);
        }
    }

    if (meData?.user) {
        const userModels = prepareUsers(operator, [meData.user]);
        if (userModels) {
            modelPromises.push(userModels);
        }
    }

    return modelPromises;
};

export const appEntry = async (serverUrl: string) => {
    const dt = Date.now();

    const {database, operator} = DatabaseManager.serverDatabases[serverUrl];
    if (!database) {
        return {error: `${serverUrl} database not found`};
    }

    const currentTeamId = await queryCurrentTeamId(database);
    const fetchedData = await fetchAppEntryData(database, serverUrl, currentTeamId);

    const {initialTeamId, teamData, chData, prefData, meData, removeTeamIds} = fetchedData;

    if (initialTeamId !== currentTeamId) {
        // Immediately set the new team as the current team in the database so that the UI
        // renders the correct team.
        // TODO: No need for initial channel once tab navigation for v2 UI is added.
        const initialChannel = selectDefaultChannelForTeam(fetchedData.chData!.channels!, fetchedData.chData!.memberships!, initialTeamId, [], fetchedData.meData.user!.locale);
        setCurrentTeamAndChannelId(operator, initialTeamId, initialChannel?.id);
    }

    const removeTeams = await queryTeamsById(database, removeTeamIds);
    if (removeTeams) {
        // Immediately delete myTeams so that the UI renders only teams the user is a member of.
        await deleteMyTeams(operator, removeTeams);
    }

    handleRoles(serverUrl, teamData, chData, meData);

    const modelPromises = await prepareModels(operator, initialTeamId, removeTeams, teamData, chData, prefData, meData);
    const models = await Promise.all(modelPromises);
    if (models.length) {
        await operator.batchRecords(models.flat() as Model[]);
    }

    const {id: currentUserId, locale: currentUserLocale} = meData.user || (await queryCurrentUser(database))!;
    const {config, license} = await queryCommonSystemValues(database);
    deferredAppEntryActions(serverUrl, currentUserId, currentUserLocale, prefData.preferences, config, license, teamData, chData, initialTeamId);

    const error = teamData.error || chData.error || prefData.error || meData.error;
    return {error, time: Date.now() - dt};
};

const deferredAppEntryActions = async (
    serverUrl: string, currentUserId: string, currentUserLocale: string, preferences: PreferenceType[] | undefined, config: ClientConfig, license: ClientLicense, teamData: MyTeamsRequest,
    chData: MyChannelsRequest, initialTeamId: string) => {
    // defer sidebar DM & GM profiles
    if (chData?.channels?.length && chData.memberships?.length) {
        const directChannels = chData.channels.filter((c) => c.type === General.DM_CHANNEL || c.type === General.GM_CHANNEL);
        const channelsToFetchProfiles = new Set<Channel>(directChannels);
        if (channelsToFetchProfiles.size) {
            const teammateDisplayNameSetting = getTeammateNameDisplaySetting(preferences || [], config, license);
            await fetchMissingSidebarInfo(serverUrl, Array.from(channelsToFetchProfiles), currentUserLocale, teammateDisplayNameSetting, currentUserId);
        }

        // defer fetching posts for unread channels on initial team
        fetchPostsForUnreadChannels(serverUrl, chData.channels, chData.memberships);
    }

    // defer groups for team
    // if (currentTeamId) {
    //     await fetchGroupsForTeam(serverUrl, currentTeamId);
    // }

    // defer fetch channels and unread posts for other teams
    if (teamData.teams?.length && teamData.memberships?.length) {
        fetchTeamsChannelsAndUnreadPosts(serverUrl, teamData.teams, teamData.memberships, initialTeamId);
    }
};

export const loginEntry = async ({serverUrl, user, deviceToken}: AfterLoginArgs) => {
    const dt = Date.now();
    const {database, operator} = DatabaseManager.serverDatabases[serverUrl];
    if (!database) {
        return {error: `${serverUrl} database not found`};
    }

    let client: Client;
    try {
        client = NetworkManager.getClient(serverUrl);
    } catch (error) {
        return {error};
    }

    if (deviceToken) {
        try {
            client.attachDevice(deviceToken);
        } catch {
            // do nothing, the token could've failed to attach to the session but is not a blocker
        }
    }

    try {
        let initialTeam: Team|undefined;
        let initialChannel: Channel|undefined;
        let myTeams: Team[]|undefined;

        // Fetch in parallel server config & license / user preferences / teams / team membership / team unreads
        const promises: [Promise<ConfigAndLicenseRequest>, Promise<MyPreferencesRequest>, Promise<MyTeamsRequest>] = [
            fetchConfigAndLicense(serverUrl, true),
            fetchMyPreferences(serverUrl, true),
            fetchMyTeams(serverUrl, true),
        ];

        const [clData, prefData, teamData] = await Promise.all(promises);
        let chData: MyChannelsRequest|undefined;

        // schedule local push notification if needed
        if (clData.config) {
            scheduleExpiredNotification(serverUrl, clData.config, user.id, user.locale);
        }

        // select initial team
        if (!clData.error && !prefData.error && !teamData.error) {
            const teamOrderPreference = getPreferenceValue(prefData.preferences!, Preferences.TEAMS_ORDER, '', '') as string;
            const teamRoles: string[] = [];
            const teamMembers: string[] = [];

            teamData.memberships?.forEach((tm) => {
                teamRoles.push(...tm.roles.split(' '));
                teamMembers.push(tm.team_id);
            });

            myTeams = teamData.teams!.filter((t) => teamMembers?.includes(t.id));
            initialTeam = selectDefaultTeam(myTeams, user.locale, teamOrderPreference, clData.config?.ExperimentalPrimaryTeam);

            if (initialTeam) {
                const rolesToFetch = new Set<string>([...user.roles.split(' '), ...teamRoles]);

                // fetch channels / channel membership for initial team
                chData = await fetchMyChannelsForTeam(serverUrl, initialTeam.id, false, 0, true);
                if (chData.channels?.length && chData.memberships?.length) {
                    const {channels, memberships} = chData;
                    const channelIds = new Set(channels?.map((c) => c.id));
                    for (let i = 0; i < memberships!.length; i++) {
                        const member = memberships[i];
                        if (channelIds.has(member.channel_id)) {
                            member.roles.split(' ').forEach(rolesToFetch.add, rolesToFetch);
                        }
                    }

                    // fetch user roles
                    const rData = await fetchRolesIfNeeded(serverUrl, Array.from(rolesToFetch));

                    // select initial channel
                    initialChannel = selectDefaultChannelForTeam(channels!, memberships!, initialTeam!.id, rData.roles, user.locale);
                }
            }
        }

        const modelPromises = await prepareModels(operator, initialTeam?.id, undefined, teamData, chData, prefData, undefined);

        const systemModels = prepareCommonSystemValues(
            operator,
            {
                config: clData.config || ({} as ClientConfig),
                license: clData.license || ({} as ClientLicense),
                currentTeamId: initialTeam?.id || '',
                currentChannelId: initialChannel?.id || '',
            },
        );
        if (systemModels) {
            modelPromises.push(systemModels);
        }

        if (initialTeam && initialChannel) {
            try {
                const tch = addChannelToTeamHistory(operator, initialTeam.id, initialChannel.id, true);
                modelPromises.push(tch);
            } catch {
                // do nothing
            }
        }

        const models = await Promise.all(modelPromises);
        if (models.length) {
            await operator.batchRecords(models.flat() as Model[]);
        }

        deferredLoginActions(serverUrl, user, prefData, clData, teamData, chData, initialTeam, initialChannel);

        const error = clData.error || prefData.error || teamData.error || chData?.error;
        return {error, time: Date.now() - dt, hasTeams: Boolean((myTeams?.length || 0) > 0 && !teamData.error)};
    } catch (error) {
        const systemModels = await prepareCommonSystemValues(operator, {
            config: ({} as ClientConfig),
            license: ({} as ClientLicense),
            currentTeamId: '',
            currentChannelId: '',
        });
        if (systemModels) {
            await operator.batchRecords(systemModels);
        }

        return {error};
    }
};

const deferredLoginActions = async (
    serverUrl: string, user: UserProfile, prefData: MyPreferencesRequest, clData: ConfigAndLicenseRequest, teamData: MyTeamsRequest,
    chData?: MyChannelsRequest, initialTeam?: Team, initialChannel?: Channel) => {
    // defer fetching posts for initial channel
    if (initialChannel) {
        fetchPostsForChannel(serverUrl, initialChannel.id);
    }

    // defer sidebar DM & GM profiles
    if (chData?.channels?.length && chData.memberships?.length) {
        const directChannels = chData.channels.filter((c) => c.type === General.DM_CHANNEL || c.type === General.GM_CHANNEL);
        const channelsToFetchProfiles = new Set<Channel>(directChannels);
        if (channelsToFetchProfiles.size) {
            const teammateDisplayNameSetting = getTeammateNameDisplaySetting(prefData.preferences || [], clData.config, clData.license);
            await fetchMissingSidebarInfo(serverUrl, Array.from(channelsToFetchProfiles), user.locale, teammateDisplayNameSetting, user.id);
        }

        // defer fetching posts for unread channels on initial team
        fetchPostsForUnreadChannels(serverUrl, chData.channels, chData.memberships, initialChannel?.id);
    }

    // defer groups for team
    // if (initialTeam) {
    //     await fetchGroupsForTeam(serverUrl, initialTeam.id);
    // }

    // defer fetch channels and unread posts for other teams
    if (teamData.teams?.length && teamData.memberships?.length) {
        fetchTeamsChannelsAndUnreadPosts(serverUrl, teamData.teams, teamData.memberships, initialTeam?.id);
    }
};