'use strict';

// The call state machine, as pure functions.
//
// It lives apart from the database on purpose: the transitions below are the
// product's rules, and the project has already paid once for letting handlers
// imply them. Nothing here touches storage or sockets, so every rule is testable
// by calling it.

const CALL_STATUSES = Object.freeze(['ringing', 'active', 'declined', 'cancelled', 'ended', 'missed']);
const PARTICIPANT_STATUSES = Object.freeze(['invited', 'accepted', 'declined', 'cancelled', 'left', 'missed']);
const TERMINAL_CALL_STATUSES = Object.freeze(['declined', 'cancelled', 'ended', 'missed']);

/** A call that is over, whichever way it ended. */
function isTerminal(status) {
    return TERMINAL_CALL_STATUSES.includes(status);
}

/** A call that still exists for the people in it. */
function isLive(status) {
    return status === 'ringing' || status === 'active';
}

/** The participants who count as being in the call. */
function activeParticipants(participants) {
    return (participants || []).filter((item) => item.status === 'accepted');
}

/** Invitees who have not answered yet. */
function pendingInvitees(participants) {
    return (participants || []).filter((item) => item.status === 'invited');
}

/**
 * Whether this participant may answer. Only an outstanding invitation counts, and
 * only once — an invitation that was already answered, cancelled, missed or left
 * cannot be answered again.
 */
function canRespond(participant) {
    return Boolean(participant) && participant.status === 'invited';
}

/**
 * Whether this participant may be admitted to the room.
 *
 * An active call admits any participant of it, including one who left earlier or
 * who never answered — a person who backgrounded the app, or who changed their
 * mind after declining, must be able to come back into a call that is still up.
 * A ringing call admits only a participant who has already accepted, which is the
 * window between answering and the room forming.
 */
function joinRefusal(call, participant) {
    if (!call) return 'CALL_NOT_FOUND';
    if (!participant) return 'NOT_A_PARTICIPANT';
    if (call.status === 'active') return null;
    if (call.status === 'ringing') return participant.status === 'accepted' ? null : 'CALL_NOT_JOINABLE';
    return 'CALL_NOT_JOINABLE';
}

/** Accepting the first invitation makes the call active. */
function statusAfterAccept(call) {
    return call.status === 'ringing' ? 'active' : call.status;
}

/**
 * The call's status once somebody declines. A ringing call is one nobody has
 * answered, so it is over when no invitation can still be answered — the caller
 * waiting is not a reason to keep it ringing, which is what would happen if the
 * caller's own acceptance counted as a participant who is in the call.
 */
function statusAfterDecline(call, participants) {
    if (call.status !== 'ringing') return call.status;
    return pendingInvitees(participants).length > 0 ? call.status : 'declined';
}

/** Ending a ringing call cancels it; ending a live one ends it. */
function statusAfterEnd(call) {
    return call.status === 'ringing' ? 'cancelled' : 'ended';
}

/**
 * A call stays up while anyone is still in it. This is the rule the previous
 * backend could not express: it ended the call for everybody the moment one
 * person hung up.
 */
function shouldEndAfterLeave(participants) {
    return activeParticipants(participants).length === 0;
}

/** Whether another participant may be added. */
function canInvite(call, inviter) {
    if (!call || !isLive(call.status)) return false;
    return Boolean(inviter) && inviter.status === 'accepted';
}

module.exports = {
    CALL_STATUSES,
    PARTICIPANT_STATUSES,
    TERMINAL_CALL_STATUSES,
    isTerminal,
    isLive,
    activeParticipants,
    pendingInvitees,
    canRespond,
    joinRefusal,
    statusAfterAccept,
    statusAfterDecline,
    statusAfterEnd,
    shouldEndAfterLeave,
    canInvite,
};
