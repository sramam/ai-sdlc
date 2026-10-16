# Domain model

## Entities

### Session

Owned by the organizer.

- PUBLISH: DRAFT → PUBLISHED · sender: @organizer
- CANCEL: PUBLISHED -> CANCELLED · sender: @organizer

### Reminder — what is sent before a session

- SEND: SCHEDULED → SENT · sender: system:scheduler

### Rsvp

No lifecycle.

## Diagram

```mermaid
erDiagram
  Session ||--o{ Rsvp : has
### NotAnEntity
- BOGUS: A → B
```
