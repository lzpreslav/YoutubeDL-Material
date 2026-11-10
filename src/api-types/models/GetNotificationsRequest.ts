/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type GetNotificationsRequest = {
    /**
     * Only return the number of unread notifications
     */
    count_only?: boolean;
    /**
     * Maximum number of notifications to return, newest first
     */
    limit?: number;
};
