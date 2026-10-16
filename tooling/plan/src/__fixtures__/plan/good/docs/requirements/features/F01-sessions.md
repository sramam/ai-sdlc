# F01 Sessions

Personas: @organizer, @attendee Journeys: J1, J2
Phase: MVP Owner: someone

## Purpose

Organizers publish sessions; attendees are reminded.

## Requirements

### F01-R01 Organizer creates a session

Actor: @organizer · Trigger: the organizer saves the form · Preconditions: signed in
Acceptance: Given a draft When saved Then it is listed
Data: Session (title, start)

### F01-R02 Remind attendees 24 hours before a session

Actor: system:scheduler
Data: Session, Reminders Lifecycle: Reminder SCHEDULED → SENT

### F01-R03 Remind by SMS — withdrawn 2026-10-01: no SMS in MVP

Actor: system:scheduler

## Out of scope

### F01-R04 Recurring sessions

Actor: @organizer

## Open questions

Q-001
