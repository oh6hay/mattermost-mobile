// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import {Model} from '@nozbe/watermelondb';
export default class App extends Model {
    static table: string;
    appId: string;
    buildNumber: string;
    createdAt: Date;
    unreadCount: string;
}