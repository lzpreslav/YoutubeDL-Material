import { Component, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { CURRENT_VERSION } from 'app/consts';

@Component({
    selector: 'app-about-dialog',
    templateUrl: './about-dialog.component.html',
    styleUrls: ['./about-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class AboutDialogComponent {

  projectLink = 'https://github.com/lzpreslav/YoutubeDL-Material';
  issuesLink = 'https://github.com/lzpreslav/YoutubeDL-Material/issues';

  current_version_tag = CURRENT_VERSION;

  constructor(public postsService: PostsService) { }
}
