/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Notification } from './Notification';

export type GetNotificationsResponse = {
    notifications?: Array<Notification>;
    /**
     * Number of unread notifications, returned instead of notifications when count_only is set
     */
    unread_count?: number;
};
